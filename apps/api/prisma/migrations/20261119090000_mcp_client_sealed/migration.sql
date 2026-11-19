-- An MCP server's client secret, sealed with the vault's key (src/connectors/mcp.ts). Only adds
-- a column: the plain-text one stays, read for rows written before, until a later deploy drops it.
-- AlterTable
ALTER TABLE "McpClient" ADD COLUMN "clientSealed" TEXT;
