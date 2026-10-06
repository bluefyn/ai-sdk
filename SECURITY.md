# Security policy

## Report a vulnerability privately

Do not open a public issue for a vulnerability. Report it in one of these ways:

- On GitHub, open the **Security** tab of this repository and click **Report a vulnerability** ([direct link](https://github.com/bluefyn/ai-sdk/security/advisories/new)). Only the maintainers can read the report.
- By email, to [support@bluefyn.ai](mailto:support@bluefyn.ai), with "Security" in the subject.

Include the SDK version, what an attacker can do, and the steps to reproduce it. Never include a real SDK key or provider API key.

Report, for example, a way the SDK could send prompt or completion content, or expose an SDK key in logs, errors, or events. Report a vulnerability in the Bluefyn service itself, such as the ingest API or app.bluefyn.ai, by email.

## Supported versions

Security fixes ship for the latest minor release of 0.x only. For example, while 0.3 is the latest minor release, a fix ships as a 0.3 patch release and 0.2 gets none. To receive fixes, upgrade to the latest minor release.
