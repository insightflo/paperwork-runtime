/**
 * [purpose] PATCH /companies/:companyId/tools/:toolId with a partial body (no adapterConfig)
 *   keeps the stored adapterConfig and enforces the artifact contract against it; a supplied
 *   non-object adapterConfig or an invalid contract is a 400 from the registry write boundary,
 *   never a 500. Uses the real registry against embedded PostgreSQL (route-level mocks cannot
 *   observe service validation).
 */
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { companies, toolDefinitions } from '@paperclipai/db';
import { eq } from 'drizzle-orm';
import { errorHandler } from '../middleware/index.js';
import { toolDefinitionRoutes } from '../routes/tool-definitions.js';
import { toolService } from '../services/tools/registry.js';
import { progressDatabase } from './helpers/tool-progress.js';

const contract = { role: 'qa', resultFileName: 'result.json', resultSchemaVersion: 'tool.qa-result.v1',
  resultAdapter: 'generic', inputParams: { content: 'document' }, deploymentFiles: ['check.mjs'], inputEnvelopeVersion: 'input.v1' };
const storedConfig = { command: 'pnpm qa', artifactContract: contract };
const invalidConfig = { command: 'pnpm qa', artifactContract: { ...contract, role: 'not-a-role' } };
const invalidPayloads: [string, unknown][] = [
  ['string', 'not-an-object'],
  ['null', null],
  ['array', []],
  ['number', 42],
  ['non-object contract', { artifactContract: 'bad' }],
  ['invalid contract', { artifactContract: { ...contract, resultFileName: '../escape.json' } }],
  ['empty deploymentFiles', { artifactContract: { ...contract, deploymentFiles: [] } }],
];

let fixture: Awaited<ReturnType<typeof progressDatabase>>, companyId: string;
function app() {
  const server = express(); server.use(express.json());
  server.use((req, _res, next) => {
    req.actor = { type: 'board', userId: 'test-board', companyIds: [companyId], source: 'authenticated', isInstanceAdmin: false };
    next();
  });
  server.use('/api', toolDefinitionRoutes(fixture.db)); server.use(errorHandler); return server;
}
const patch = (toolId: string) => request(app()).patch(`/api/companies/${companyId}/tools/${toolId}`);
const storedRow = async (toolId: string) =>
  (await fixture.reader.select().from(toolDefinitions).where(eq(toolDefinitions.id, toolId)))[0];
async function createTool(name: string, adapterConfig: Record<string, unknown> = storedConfig) {
  const tool = await toolService.createDefinition(fixture.db, {
    companyId, name: `${name}-${randomUUID()}`, adapterType: 'builtin', adapterConfig,
  });
  return tool.id;
}

beforeAll(async () => {
  fixture = await progressDatabase();
  [companyId] = (await fixture.db.insert(companies).values({ name: 'Partial tool patch', issuePrefix: randomUUID() }).returning()).map(c => c.id);
}, 60_000);
afterAll(async () => { await fixture?.cleanup(); });

describe('partial tool definition PATCH keeps and validates the stored adapterConfig', () => {
  it.each([
    ['inputSchema', { inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }],
    ['description', { description: 'Only the description changes.' }],
    ['enabled', { enabled: false }],
  ])('updates only %s, preserving the stored adapterConfig and its contract', async (_label, body) => {
    const toolId = await createTool('partial');
    const response = await patch(toolId).send(body);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject(body);
    // The route masks some contract fields for display, so exactness is checked on the row.
    expect(response.body.adapterConfig).toMatchObject({ command: 'pnpm qa', artifactContract: { role: 'qa', inputParams: { content: 'document' } } });
    const row = await storedRow(toolId);
    expect(row.adapterConfig).toEqual(storedConfig);
    expect(row).toMatchObject(body);
  });

  it('accepts an explicit undefined adapterConfig from a direct service caller', async () => {
    const toolId = await createTool('undefined');
    const tool = await toolService.updateDefinition(fixture.db, toolId, { description: 'direct', adapterConfig: undefined });

    expect(tool?.description).toBe('direct');
    expect((await storedRow(toolId)).adapterConfig).toEqual(storedConfig);
  });

  it.each(invalidPayloads)('rejects a %s adapterConfig with 400 and writes nothing', async (_label, adapterConfig) => {
    const toolId = await createTool('invalid');

    const response = await patch(toolId).send({ adapterConfig, description: 'must not persist' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBeTruthy();
    const row = await storedRow(toolId);
    expect(row.adapterConfig).toEqual(storedConfig);
    expect(row.description).toBe('');
  });

  it.each(invalidPayloads)('rejects a %s adapterConfig at the service boundary with 400', async (_label, adapterConfig) => {
    const toolId = await createTool('direct-invalid');

    await expect(toolService.updateDefinition(fixture.db, toolId, { adapterConfig } as never))
      .rejects.toMatchObject({ status: 400 });
    expect((await storedRow(toolId)).adapterConfig).toEqual(storedConfig);
  });

  it('returns 400, not 500, when a direct update of a missing tool supplies an invalid contract', async () => {
    await expect(toolService.updateDefinition(fixture.db, randomUUID(), { adapterConfig: { artifactContract: 'bad' } }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('validates the stored contract on a partial update of a row that predates validation', async () => {
    // Written directly, as a row saved before contract validation existed would be.
    const [row] = await fixture.db.insert(toolDefinitions).values({
      companyId, name: `legacy-invalid-${randomUUID()}`, adapterType: 'builtin', adapterConfig: invalidConfig,
    }).returning({ id: toolDefinitions.id });
    const toolId = row.id;

    const response = await patch(toolId).send({ inputSchema: { type: 'object' } });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid tool artifactContract');
    expect((await storedRow(toolId)).adapterConfig).toEqual(invalidConfig);

    const repaired = await patch(toolId).send({ adapterConfig: { ...invalidConfig, artifactContract: contract } });
    expect(repaired.status).toBe(200);
    const partial = await patch(toolId).send({ inputSchema: { type: 'object' } });
    expect(partial.status).toBe(200);
    expect(partial.body.adapterConfig.artifactContract).toMatchObject({ role: 'qa', inputParams: { content: 'document' } });
    expect((await storedRow(toolId)).adapterConfig).toEqual(storedConfig);
  });
});
