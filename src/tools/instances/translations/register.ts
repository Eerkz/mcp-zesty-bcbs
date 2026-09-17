import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/**
 * Field datatypes holding human-readable prose worth translating. Treated as an
 * allowlist rather than a denylist so a datatype we have not seen before (a new
 * relationship or media type) is skipped instead of mangled.
 */
const TRANSLATABLE_DATATYPES = new Set([
    'text',
    'textarea',
    'wysiwyg_basic',
    'wysiwyg_advanced',
    'markdown',
    'article_writer',
]);

/** SEO fields on `web` that hold prose. `pathPart` is deliberately excluded — translating it rewrites live URLs. */
const TRANSLATABLE_WEB_FIELDS = ['metaTitle', 'metaDescription', 'metaKeywords', 'metaLinkText'] as const;

/**
 * Column limits the API enforces on `web` fields, measured against the live API.
 * These matter for translation specifically: Spanish and French run roughly 15-25%
 * longer than English, so a source string that sits just under a limit will overflow
 * once translated. Checked before the write so the failure is legible.
 */
const MAX_WEB_LENGTHS: Record<string, number> = {
    metaTitle: 255,
    metaLinkText: 255,
    metaKeywords: 255,
    metaDescription: 159,
};

/**
 * The API's rejection when a PUT echoes back a `pathPart` it considers taken — which
 * includes the item's own path. See the retry in `apply-translations`.
 */
const PATH_PART_IN_USE = /path part .* is already in use/i;

/** `web` keys the API derives or manages itself; echoing them back on a PUT is at best ignored. */
const SERVER_MANAGED_WEB_FIELDS = new Set([
    'version',
    'versionZUID',
    'path',
    'createdAt',
    'updatedAt',
    'createdByUserZUID',
]);

/** Writes are chunked to stay under the per-IP burst limit the SDK notes for bulk item operations. */
const WRITE_CONCURRENCY = 10;

/**
 * Strips the leading and trailing slashes a locale homepage stores in its `pathPart`
 * (e.g. "/fr/" rather than "fr"). Those slashes are redundant — the API rebuilds the
 * full path from the parent chain either way, verified against the live API: "/fr/"
 * and "fr" both resolve to the path "/fr/". Interior slashes are left alone, so a
 * multi-segment pathPart keeps its shape.
 *
 * Returns null when there is nothing to strip, or when stripping would leave an empty
 * string — the API requires a non-empty pathPart to compute a path, so an empty retry
 * would only trade one failure for another.
 */
function normalizePathPart(pathPart: unknown): string | null {
    if (typeof pathPart !== 'string') return null;
    const stripped = pathPart.replace(/^\/+/, '').replace(/\/+$/, '');
    return stripped && stripped !== pathPart ? stripped : null;
}

/**
 * The SDK resolves non-2xx responses rather than throwing (only `getItems` checks
 * `statusCode` itself), so a rejected write would otherwise look like a success.
 */
function assertOk(res: any, context: string) {
    if (!res || (res.statusCode !== 200 && res.statusCode !== 201)) {
        const detail = res?.error ?? res?.message ?? JSON.stringify(res);
        throw new Error(`${context} failed (status ${res?.statusCode}): ${detail}`);
    }
    return res;
}

type Lang = { ID: number; code: string; name: string; active: boolean; default: boolean };

function toResult(payload: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

function toError(error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
        isError: true,
        content: [{ type: 'text' as const, text: `Error: ${errorMessage}` }],
    };
}

/** Resolves a language code ("es-MX") or numeric ID ("2") against the instance's language list. */
function resolveLang(langs: Lang[], needle: string): Lang {
    const match = langs.find(
        (lang) => lang.code.toLowerCase() === needle.toLowerCase() || String(lang.ID) === needle,
    );

    if (!match) {
        const available = langs.map((lang) => `${lang.code} (ID ${lang.ID})`).join(', ');
        throw new Error(`Unknown language "${needle}". Available languages: ${available}`);
    }

    return match;
}

export function registerTranslationsTools(server: McpServer, sdk: any) {
    server.tool(
        'get-translation-batch',
        [
            'Collects source-language content items and pairs each one with its existing target-language sibling,',
            'returning only the fields that hold translatable prose. Does not write anything.',
            'Translate the returned strings yourself, then pass them to `apply-translations` to write them back.',
            'Preserve all HTML tags, attributes and href values in wysiwyg/markdown fields — translate text nodes only.',
        ].join(' '),
        {
            TARGET_LANG: z.string().describe('Target language code (e.g. "es-MX") or numeric lang ID (e.g. "2")'),
            SOURCE_LANG: z.string().optional().describe('Source language code. Defaults to "en-US"'),
            MODEL_ZUID: z.string().optional().describe('Limit to a single content model. Omit to cover every model'),
            INCLUDE_SEO: z
                .boolean()
                .optional()
                .describe('Include web meta fields (metaTitle, metaDescription, metaKeywords, metaLinkText). Defaults to true'),
            LIMIT: z.number().optional().describe('Maximum number of items to return, to keep the payload manageable'),
        },
        async ({ TARGET_LANG, SOURCE_LANG, MODEL_ZUID, INCLUDE_SEO, LIMIT }) => {
            try {
                const sourceCode = SOURCE_LANG ?? 'en-US';
                const includeSeo = INCLUDE_SEO ?? true;

                const langsRes = await sdk.instance.fetchLangs();
                const langs: Lang[] = langsRes?.data ?? [];

                const target = resolveLang(langs, TARGET_LANG);
                const source = resolveLang(langs, sourceCode);

                if (target.ID === source.ID) {
                    throw new Error(`Target language "${target.code}" is the same as the source language`);
                }
                if (!target.active) {
                    throw new Error(`Target language "${target.code}" is not active on this instance`);
                }

                const models = MODEL_ZUID
                    ? [{ ZUID: MODEL_ZUID }]
                    : ((await sdk.instance.getModels())?.data ?? []);

                const jobs: unknown[] = [];
                const skipped: unknown[] = [];

                for (const model of models) {
                    const modelZUID = model.ZUID;

                    // Field datatypes decide what is prose and what is a reference/asset.
                    const fieldsRes = await sdk.instance.getModelFields(modelZUID);
                    const translatableFields = (fieldsRes?.data ?? [])
                        .filter((field: any) => TRANSLATABLE_DATATYPES.has(field.datatype))
                        .map((field: any) => field.name);

                    if (!translatableFields.length) {
                        skipped.push({ modelZUID, reason: 'model has no translatable fields' });
                        continue;
                    }

                    // The SDK pages through this internally and returns the full set.
                    const itemsRes = await sdk.instance.getItems(modelZUID, {
                        lang: source.code,
                        limit: 5000,
                        page: 1,
                        _active: 0,
                    });

                    for (const item of itemsRes?.data ?? []) {
                        if (LIMIT !== undefined && jobs.length >= LIMIT) break;

                        const sourceZUID = item?.meta?.ZUID;
                        const targetZUID = item?.siblings?.[target.code];

                        if (!targetZUID) {
                            skipped.push({
                                modelZUID,
                                sourceZUID,
                                reason: `no ${target.code} sibling exists for this item`,
                            });
                            continue;
                        }

                        const data: Record<string, string> = {};
                        for (const name of translatableFields) {
                            const value = item?.data?.[name];
                            if (typeof value === 'string' && value.trim()) {
                                data[name] = value;
                            }
                        }

                        const web: Record<string, string> = {};
                        if (includeSeo) {
                            for (const name of TRANSLATABLE_WEB_FIELDS) {
                                const value = item?.web?.[name];
                                if (typeof value === 'string' && value.trim()) {
                                    web[name] = value;
                                }
                            }
                        }

                        if (!Object.keys(data).length && !Object.keys(web).length) {
                            skipped.push({ modelZUID, sourceZUID, reason: 'no non-empty translatable content' });
                            continue;
                        }

                        jobs.push({ MODEL_ZUID: modelZUID, SOURCE_ZUID: sourceZUID, TARGET_ZUID: targetZUID, data, web });
                    }

                    if (LIMIT !== undefined && jobs.length >= LIMIT) break;
                }

                return toResult({
                    sourceLang: { code: source.code, ID: source.ID },
                    targetLang: { code: target.code, ID: target.ID },
                    counts: { jobs: jobs.length, skipped: skipped.length },
                    maxWebFieldLengths: MAX_WEB_LENGTHS,
                    note:
                        'Translations must respect maxWebFieldLengths. Translated text is usually longer than the ' +
                        'English source, so shorten rather than exceed a limit. In wysiwyg/markdown fields, translate ' +
                        'text nodes only and leave HTML tags, attributes and href values exactly as they are.',
                    jobs,
                    skipped,
                });
            } catch (error: unknown) {
                return toError(error);
            }
        },
    );

    server.tool(
        'apply-translations',
        [
            'Writes translated content onto existing target-language content items produced by `get-translation-batch`.',
            'Each target item is re-read and merged before writing, because the update endpoint is a full replace —',
            'fields that are not translated keep their current values. Refuses to write to an item whose language does',
            'not match TARGET_LANG, which prevents overwriting the source-language master.',
            'Updates create a new draft version; they are not published. Note that `get-item` returns the published',
            'version, so it will NOT show these changes — use `get-item-versions` to verify a write landed.',
        ].join(' '),
        {
            TARGET_LANG: z.string().describe('Target language code (e.g. "es-MX") or numeric lang ID. Used to verify every write lands on the right language'),
            TRANSLATIONS: z
                .array(
                    z.object({
                        MODEL_ZUID: z.string().describe('Content model ZUID'),
                        TARGET_ZUID: z.string().describe('Target-language content item ZUID to write to'),
                        data: z.record(z.string()).optional().describe('Translated content fields, keyed by field name'),
                        web: z.record(z.string()).optional().describe('Translated SEO fields (metaTitle, metaDescription, metaKeywords, metaLinkText)'),
                    }),
                )
                .describe('Translated items to write'),
            DRY_RUN: z
                .boolean()
                .optional()
                .describe('Build and return the payloads without writing. Use this to verify one item before a bulk run. Defaults to false'),
        },
        async ({ TARGET_LANG, TRANSLATIONS, DRY_RUN }) => {
            try {
                const dryRun = DRY_RUN ?? false;

                const langsRes = await sdk.instance.fetchLangs();
                const target = resolveLang(langsRes?.data ?? [], TARGET_LANG);

                const applyOne = async (entry: (typeof TRANSLATIONS)[number]) => {
                    const { MODEL_ZUID, TARGET_ZUID } = entry;

                    try {
                        const currentRes = await sdk.instance.getItem(MODEL_ZUID, TARGET_ZUID);
                        const current = currentRes?.data;

                        // Some sibling ZUIDs resolve to nothing; skip rather than fabricate an item.
                        if (!current) {
                            return { TARGET_ZUID, ok: false, skipped: true, error: 'item not found or has no content version' };
                        }

                        // The guard that stops a translation run from overwriting the source master.
                        if (current.meta?.langID !== target.ID) {
                            return {
                                TARGET_ZUID,
                                ok: false,
                                skipped: true,
                                error: `item langID ${current.meta?.langID} does not match target ${target.code} (ID ${target.ID})`,
                            };
                        }

                        // Catch length overflows here so the caller gets the field name and the
                        // limit, rather than a generic 400 after the request round-trips.
                        const tooLong = Object.entries(entry.web ?? {})
                            .filter(([key, value]) => value.length > (MAX_WEB_LENGTHS[key] ?? Infinity))
                            .map(([key, value]) => `${key} is ${value.length} chars, max ${MAX_WEB_LENGTHS[key]}`);

                        if (tooLong.length) {
                            return { TARGET_ZUID, ok: false, skipped: true, error: tooLong.join('; ') };
                        }

                        const web: Record<string, unknown> = {};
                        for (const [key, value] of Object.entries(current.web ?? {})) {
                            if (!SERVER_MANAGED_WEB_FIELDS.has(key)) web[key] = value;
                        }

                        const payload = {
                            data: { ...(current.data ?? {}), ...(entry.data ?? {}) },
                            web: { ...web, ...(entry.web ?? {}) },
                            meta: {
                                masterZUID: current.meta?.masterZUID,
                                sort: current.meta?.sort,
                                listed: current.meta?.listed,
                            },
                        };

                        if (dryRun) {
                            return { TARGET_ZUID, ok: true, dryRun: true, payload };
                        }

                        const write = async (body: typeof payload) =>
                            assertOk(await sdk.instance.updateItem(MODEL_ZUID, TARGET_ZUID, body), 'updateItem');

                        let res: any;
                        let pathPartNormalized: string | null = null;

                        try {
                            res = await write(payload);
                        } catch (error: unknown) {
                            // A locale homepage can store its full path (e.g. "/fr/") as its pathPart.
                            // We never translate the field, but echoing it back on this full-replace PUT
                            // trips the API's uniqueness check against the item's own path. Retrying with
                            // the redundant slashes stripped leaves the rebuilt path identical and lets
                            // the copy land. Omitting pathPart instead is not an option: the API then
                            // rejects the PUT with "unable to calculate full path without path part".
                            // Only reached when the write has already failed, so writes that succeed
                            // today still send pathPart exactly as before.
                            const message = error instanceof Error ? error.message : JSON.stringify(error);
                            const normalized = normalizePathPart(payload.web.pathPart);
                            if (!PATH_PART_IN_USE.test(message) || !normalized) throw error;

                            res = await write({ ...payload, web: { ...payload.web, pathPart: normalized } });
                            pathPartNormalized = normalized;
                        }

                        return {
                            TARGET_ZUID,
                            ok: true,
                            version: res.data?.version,
                            versionZUID: res.data?.version_zuid,
                            ...(pathPartNormalized ? { pathPartNormalized } : {}),
                        };
                    } catch (error: unknown) {
                        const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
                        return { TARGET_ZUID, ok: false, error: errorMessage };
                    }
                };

                const results: unknown[] = [];
                for (let i = 0; i < TRANSLATIONS.length; i += WRITE_CONCURRENCY) {
                    const chunk = TRANSLATIONS.slice(i, i + WRITE_CONCURRENCY);
                    results.push(...(await Promise.all(chunk.map(applyOne))));
                }

                const updated = results.filter((r: any) => r.ok && !r.dryRun).length;
                const failed = results.filter((r: any) => !r.ok).length;

                return toResult({
                    targetLang: { code: target.code, ID: target.ID },
                    dryRun,
                    counts: { total: results.length, updated, failed },
                    results,
                });
            } catch (error: unknown) {
                return toError(error);
            }
        },
    );
}
