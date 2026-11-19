-- An MCP server's client secret, sealed with the vault's key (src/connectors/mcp.ts). Only adds
-- a column: the plain-text one is still written and read by an API from before it; the next
-- deploy stops writing it and clears it, once every row is sealed (job mcp-client-seal).
-- AlterTable
ALTER TABLE "McpClient" ADD COLUMN "clientSealed" TEXT;
