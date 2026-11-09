# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 2.5.x   | ✅        |
| < 2.5   | ❌        |

Only the latest published `2.5.x` release receives security fixes. Please upgrade before reporting.

## Reporting a Vulnerability

**Do not open a public issue for security reports.**

Use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/nguyendinhphongdx/figma-bridge-mcp/security/advisories/new)
2. Click **Report a vulnerability**
3. Include reproduction steps, affected version, and impact

Only the maintainers can see the report until a fix is published.

### What to expect

- **Acknowledgement:** within 5 business days
- **Assessment:** within 14 days
- **Fix + advisory:** coordinated disclosure once a patched release is out

Reporters are credited in the advisory unless they ask otherwise.

## Scope

`figma-bridge-mcp` runs an HTTP bridge bound to `localhost:38451` and executes `figma_write` JavaScript inside a VM sandbox. The bridge accepts only requests with no `Origin` or `Origin: null` and a loopback `Host`, so web pages and DNS rebinding cannot reach it. The sandbox is `node:vm` hardened against the constructor escape; it is not a process boundary, so treat `figma_write` code as having your user's trust level. Reports are in scope when they involve:

- Sandbox escape from `figma_write` code execution
- The bridge accepting connections from non-local origins
- Command or code injection through MCP tool parameters
- Leakage of Figma document data outside the local machine
- Dependency vulnerabilities reachable through normal use

Out of scope:

- Issues requiring an already-compromised local machine
- Vulnerabilities in Figma Desktop or the Figma plugin API itself
- Denial of service against your own local bridge
