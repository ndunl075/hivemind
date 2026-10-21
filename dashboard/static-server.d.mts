import type { Server } from 'node:http';
export function startStaticServer(dist: string, port: number): Promise<Server>;
