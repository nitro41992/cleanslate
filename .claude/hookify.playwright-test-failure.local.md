---
name: playwright-test-failure
enabled: true
event: bash
pattern: (FAILED|failed|✘|Error:|AssertionError|expect\(.*\)\.to|Timeout|Test timeout|×).*\d+\s*(failed|failing)?|(\d+\s+failed)
action: warn
---

🛑 **Playwright Test Failure Detected**

Tests have failed. Let's stop here and work together to address this.

**Next steps:**
1. Review the error message above
2. Identify whether this is:
   - A bug in the implementation
   - A bug in the test itself
   - An environmental issue
3. Discuss with you before proceeding

**Do not continue running more tests or making changes until we've diagnosed the failure together.**
