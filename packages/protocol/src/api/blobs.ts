import { AgentBlobInfoSchema } from '../messages/agent'

/** `POST /api/v1/blobs` (`packages/core/src/api/blobs.ts`) — `c.json(info, 201)`, bare, no wrapper. */
export const UploadBlobResponseSchema = AgentBlobInfoSchema
