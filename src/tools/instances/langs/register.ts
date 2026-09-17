import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** Actions the update-lang endpoint accepts on its `action` query parameter. */
const LANG_ACTIONS = ['activate', 'deactivate', 'undelete'] as const;

/**
 * Language codes are interpolated straight into the request path by the SDK
 * (`/env/langs/LANGUAGE_CODE`), so anything outside this character set is rejected
 * before it can reshape the URL. The API stays the authority on which codes actually
 * exist — Zesty accepts 200+ variants, and mirroring that list here would only rot.
 */
const SAFE_LANG_CODE = /^[A-Za-z0-9-]+$/;

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

/**
 * The SDK resolves non-2xx responses rather than throwing, so an unchecked call
 * reports a 400 as a success. Every write below goes through this.
 */
function assertOk(res: any, context: string) {
    if (!res || (res.statusCode !== 200 && res.statusCode !== 201)) {
        const detail = res?.error ?? res?.message ?? JSON.stringify(res);
        throw new Error(`${context} failed (status ${res?.statusCode}): ${detail}`);
    }
    return res;
}

function assertSafeCode(code: string) {
    if (!SAFE_LANG_CODE.test(code)) {
        throw new Error(
            `Invalid language code "${code}". Expected letters, digits and hyphens, e.g. "fr" or "es-MX"`,
        );
    }
}

/** `fetchLangs` returns only non-deleted languages, so a miss here can still mean "soft-deleted". */
async function findLang(sdk: any, code: string): Promise<Lang | undefined> {
    const res = assertOk(await sdk.instance.fetchLangs(), 'fetchLangs');
    return (res.data ?? []).find((lang: Lang) => lang.code.toLowerCase() === code.toLowerCase());
}

export function registerLangsTools(server: McpServer, sdk: any) {
    server.tool(
        'get-langs',
        'Returns the non-deleted languages available for this instance',
        {},
        async () => {
            try {
                return toResult(await sdk.instance.fetchLangs());
            } catch (error: unknown) {
                return toError(error);
            }
        },
    );

    server.tool(
        'add-lang',
        [
            'Adds a language to this instance and optionally activates it.',
            'Creating a language replicates every content item from the default language into the new',
            'language — each copy keeps the default-language text until it is translated, so this is a',
            'bulk write across the whole instance, not a cheap no-op.',
            'Zesty creates languages inactive so translations can be staged before the locale becomes',
            'reachable on the live site; pass ACTIVATE true to activate in the same call.',
            'Safe to re-run: if the code already exists the language is not recreated (created=false),',
            'and ACTIVATE is still applied. A previously deleted language will not be found here —',
            'restore it with `update-lang` using the "undelete" action instead.',
            'Translate the replicated items with `get-translation-batch` and `apply-translations`.',
        ].join(' '),
        {
            CODE: z.string().describe('Language code to add, e.g. "fr" or "es-MX"'),
            ACTIVATE: z
                .boolean()
                .optional()
                .describe(
                    'Activate the language for routing once it exists. Defaults to false, matching the API, ' +
                        'which keeps the locale off the live site until its content is translated',
                ),
        },
        async ({ CODE, ACTIVATE }) => {
            try {
                const activate = ACTIVATE ?? false;
                assertSafeCode(CODE);

                const existing = await findLang(sdk, CODE);
                let lang: Lang | undefined = existing;

                if (!lang) {
                    // createLang echoes back only `{ ID }` — no `code`, no `active` — so the record
                    // is re-read rather than trusted, otherwise the activate below would receive an
                    // undefined code and the SDK would reject it.
                    assertOk(await sdk.instance.createLang({ code: CODE }), 'createLang');
                    lang = await findLang(sdk, CODE);

                    if (!lang) {
                        throw new Error(
                            `Language "${CODE}" was created but is missing from fetchLangs, so it could not be activated`,
                        );
                    }
                }

                // Skipped when the language is already active, so re-running is cheap and quiet.
                let activated = false;
                if (activate && !lang.active) {
                    assertOk(await sdk.instance.updateLang(lang.code, 'activate'), 'updateLang');
                    // The response body is `{ ID }` again; the call succeeded, so record the new state.
                    lang = { ...lang, active: true };
                    activated = true;
                }

                return toResult({
                    created: !existing,
                    activated,
                    lang,
                    note: !existing
                        ? 'Content items were replicated from the default language and still hold its text. ' +
                          'Run `get-translation-batch` for this code to collect them, then `apply-translations`.'
                        : `Language "${CODE}" already existed, so nothing was replicated.`,
                });
            } catch (error: unknown) {
                return toError(error);
            }
        },
    );

    server.tool(
        'update-lang',
        [
            'Changes the state of an existing language.',
            '"activate" makes the locale routable on the live site, "deactivate" removes it from routing',
            'without deleting its content, and "undelete" restores a previously deleted language.',
            'Use `add-lang` to create a language that does not exist yet.',
        ].join(' '),
        {
            CODE: z.string().describe('Language code to update, e.g. "fr" or "es-MX"'),
            ACTION: z
                .enum(LANG_ACTIONS)
                .describe('activate (enable routing), deactivate (disable routing), or undelete (restore)'),
        },
        async ({ CODE, ACTION }) => {
            try {
                assertSafeCode(CODE);

                // The API rejects a redundant activate/deactivate with a 400 ("fr is already
                // active"), which turns an otherwise harmless retry into a failure. Resolving the
                // current state first lets the no-op report success instead. "undelete" is not
                // pre-checked: deleted languages are absent from fetchLangs, so there is nothing
                // to compare against.
                if (ACTION !== 'undelete') {
                    const current = await findLang(sdk, CODE);

                    if (!current) {
                        throw new Error(
                            `Language "${CODE}" not found on this instance. Use \`add-lang\` to create it, ` +
                                'or `update-lang` with the "undelete" action if it was deleted',
                        );
                    }

                    const wantActive = ACTION === 'activate';
                    if (current.active === wantActive) {
                        return toResult({
                            action: ACTION,
                            changed: false,
                            lang: current,
                            note: `Language "${current.code}" is already ${wantActive ? 'active' : 'inactive'}.`,
                        });
                    }
                }

                const res = assertOk(await sdk.instance.updateLang(CODE, ACTION), `updateLang(${ACTION})`);

                return toResult({ action: ACTION, changed: true, lang: res.data });
            } catch (error: unknown) {
                return toError(error);
            }
        },
    );
}
