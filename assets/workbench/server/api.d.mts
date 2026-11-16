import type { IncomingMessage, ServerResponse } from 'node:http';
export function api(req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): Promise<void>;
