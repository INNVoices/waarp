# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. This includes anything
involving leaked secrets, authentication, privilege escalation, remote code
execution, or a way to escape the tunnel or routing rules (network escape).

Use GitHub Private Vulnerability Reporting instead:

1. Open the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the problem and how to reproduce it.

Do not include real keys, subscription URLs, tokens or private server addresses in
your report. Placeholders are fine.

If you are not sure whether something is a security problem, report it privately
anyway. Ordinary bugs and routing problems can go through the normal issue forms.

## Scope notes

- The local companion bridge (`docs/BRIDGE.md`) is a same-Windows-user boundary. Its token file is
  protected from other ordinary users by a private ACL, but a process already running as the same
  Windows user may be able to read it. Token possession authorizes bridge calls. Reading the token
  as the same user is not a vulnerability by itself; a bridge call that leaks keys, configs or server
  addresses, or opens the tunnel, is.
- Waarp has no independent WFP/firewall kill switch. Traffic going over the normal route after an
  engine crash is a documented limitation, not a vulnerability.
