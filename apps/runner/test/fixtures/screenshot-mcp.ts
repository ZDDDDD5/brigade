// A stand-in for the teammate's browser MCP server (browser-relay.ts in front of Playwright's):
// one tool, named as Playwright's, that answers with a picture, so a test sees whether the
// picture reaches the model. Run with tsx over stdio.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

// A 1×1 PNG.
export const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const server = new McpServer({ name: 'browser', version: '1.0.0' })
server.registerTool(
  'browser_take_screenshot',
  { description: 'Take a screenshot of the current page.' },
  async () => ({
    content: [
      { type: 'text', text: 'Screenshot of https://example.com' },
      { type: 'image', data: PIXEL, mimeType: 'image/png' },
    ],
  }),
)
await server.connect(new StdioServerTransport())
