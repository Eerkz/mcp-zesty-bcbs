import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerItemsTools(server: McpServer, sdk: any) {
    server.tool(
        "get-items",
        "Returns all content items belonging to a content model, for a given language",
        {
            MODEL_ZUID: z.string().describe("Model ZUID"),
            LANG: z.string().optional().describe('Language code to fetch items for, e.g. "es-MX". Defaults to "en-US"'),
            PUBLISHED_ONLY: z
                .boolean()
                .optional()
                .describe(
                    'Only return items that have a published version (API `_active=1`). Defaults to false, ' +
                    'which also includes unpublished drafts. Note that translations written by ' +
                    '`apply-translations` are drafts, so they are only visible with the default.'
                )
        },
        async ({ MODEL_ZUID, LANG, PUBLISHED_ONLY }) => {
            try {
                const data = await sdk.instance.getItems(MODEL_ZUID, {
                    lang: LANG ?? "en-US",
                    limit: 5000,
                    page: 1,
                    _active: PUBLISHED_ONLY ? 1 : 0,
                });

                return {
                    content: [
                        {
                        type: "text",
                        text: JSON.stringify(data),
                        },
                    ],
                };
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : String(error)
                return {
                    isError: true,
                    content: [
                        {
                            type: 'text',
                            text: `Error: ${errorMessage}`,
                        },
                    ],
                }
            }
        },
    );

    server.tool(
        "get-item",
        "Returns a single content item object",
        {
            MODEL_ZUID: z.string().describe("Model ZUID"),
            ITEM_ZUID: z.string().describe("Content Item ZUID")
        },
        async ({ MODEL_ZUID, ITEM_ZUID }) => {
            try {
                const data = await sdk.instance.getItem(MODEL_ZUID, ITEM_ZUID);

                // The API answers an unknown item ZUID with HTTP 200 and a null body
                // rather than a 404, so a missing item is otherwise indistinguishable
                // from a successful fetch.
                if (!data?.data) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text:
                                    `Error: no item found for ITEM_ZUID \`${ITEM_ZUID}\` in model \`${MODEL_ZUID}\`. ` +
                                    `The API returned HTTP ${data?.statusCode ?? 'unknown'} with an empty body, which means ` +
                                    `the item does not exist, was deleted, or belongs to a different model.`,
                            },
                        ],
                    };
                }

                return {
                    content: [
                        {
                        type: "text",
                        text: JSON.stringify(data),
                        },
                    ],
                };
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : String(error)
                return {
                    isError: true,
                    content: [
                        {
                            type: 'text',
                            text: `Error: ${errorMessage}`,
                        },
                    ],
                }
            }
        },
    );

    server.tool(
        "search-content-item",
        "Allows searching for contents by either ZUID, meta text values or path-related values",
        {
            SEARCH_TERM: z.string().describe("Search Term"),
        },
        async ({ SEARCH_TERM }) => {
            try {
                const data = await sdk.instance.findItem(SEARCH_TERM);

                return {
                    content: [
                        {
                        type: "text",
                        text: JSON.stringify(data),
                        },
                    ],
                };
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : String(error)
                return {
                    isError: true,
                    content: [
                        {
                            type: 'text',
                            text: `Error: ${errorMessage}`,
                        },
                    ],
                }
            }
        },
    );
}