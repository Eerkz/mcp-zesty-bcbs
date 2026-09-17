import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAuditLogsTools } from './audit-logs/register.js';
import { registerFieldsTools } from './fields/register.js';
import { registerHeadTagsTools } from './head-tags/register.js';
import { registerItemLabelingsTools } from './item-labelings/register.js';
import { registerItemPublishingsTools } from './item-publishings/register.js';
import { registerItemVersionsTools } from './item-versions/register.js';
import { registerItemsTools } from './items/register.js';
import { registerLabelsTools } from './labels/register.js';
import { registerLangsTools } from './langs/register.js';
import { registerLinksTools } from './links/register.js';
import { registerModelsTools } from './models/register.js';
import { registerRedirectsTools } from './redirects/register.js';
import { registerSettingsTools } from './settings/register.js';
import { registerStylesheetVariablesTools } from './stylesheet-variables/register.js';
import { registerStylesheetsTools } from './stylesheets/register.js';
import { registerTranslationsTools } from './translations/register.js';
import { registerWebHeadersTools } from './web-headers/register.js';

export function registerInstancesTools(server: McpServer, sdk: any) {
    registerAuditLogsTools(server, sdk);
    registerFieldsTools(server, sdk);
    registerHeadTagsTools(server, sdk);
    registerItemLabelingsTools(server, sdk);
    registerItemPublishingsTools(server, sdk);
    registerItemVersionsTools(server, sdk);
    registerItemsTools(server, sdk);
    registerLabelsTools(server, sdk);
    registerLangsTools(server, sdk);
    registerLinksTools(server, sdk);
    registerModelsTools(server, sdk);
    registerRedirectsTools(server, sdk);
    registerSettingsTools(server, sdk);
    registerStylesheetVariablesTools(server, sdk);
    registerStylesheetsTools(server, sdk);
    registerTranslationsTools(server, sdk);
    registerWebHeadersTools(server, sdk);
}