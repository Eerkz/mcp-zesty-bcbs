import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// The audit endpoint caps a single response (100 records when no limit is sent),
// so every request is paged. 500 keeps the round-trip count low without asking
// for a response the API will truncate.
const AUDIT_PAGE_SIZE = 500;

// Backstop so a misbehaving endpoint cannot spin forever.
const AUDIT_MAX_PAGES = 200;

export function registerAuditLogsTools(server: McpServer, sdk: any) {
    server.tool(
        "get-audit-logs",
        "Get the audit trail of an instance, paging through every record rather than " +
        "returning only the first page. Records are newest-first. Optionally pass " +
        "SEARCH_PARAMS to filter server-side and keep the payload small.",
        {
            SEARCH_PARAMS: z
                .string()
                .optional()
                .describe(
                    'Raw query string to filter on, e.g. "action=3" or ' +
                    '"affectedZUID=7-8cfc82f4f3-49c375". Any page or limit you include is ' +
                    'ignored, because this tool pages for you.'
                ),
        },
        async ({ SEARCH_PARAMS }) => {
            try {
                const filters = (SEARCH_PARAMS ?? '')
                    .split('&')
                    .map((part) => part.trim())
                    .filter((part) => part && !/^(page|limit)=/i.test(part));

                const records: unknown[] = [];
                let response: any;
                let page = 1;

                while (page <= AUDIT_MAX_PAGES) {
                    const query = [...filters, `page=${page}`, `limit=${AUDIT_PAGE_SIZE}`].join('&');
                    response = await sdk.instance.searchAuditLogs(query);

                    const batch = response?.data ?? [];
                    records.push(...batch);

                    if (batch.length < AUDIT_PAGE_SIZE) break;
                    page++;
                }

                const data = {
                    ...response,
                    data: records,
                    _meta: { ...response?._meta, totalResults: records.length, limit: records.length },
                };

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
        "get-audit-log",
        "Get a specific audit trail by audit ZUID",
        { AUDIT_ZUID: z.string().describe("Audit ZUID") },
        async ({ AUDIT_ZUID }) => {
            try {
                const data = await sdk.instance.getAuditLog(AUDIT_ZUID);

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