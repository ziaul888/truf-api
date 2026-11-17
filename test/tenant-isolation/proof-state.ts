import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import type { ProofDatabase } from './proof-database.js';
import type { ProofFixtures } from './proof-fixtures.js';
import type { ProofOperations } from './proof-operations.js';

export interface ProofState {
  db: ProofDatabase;
  fixtures: ProofFixtures;
  operations: ProofOperations;
  app: INestApplication<Server>;
  cookies: { a: string; b: string; manager: string; outsider: string };
}
export type GetProof = () => ProofState;
