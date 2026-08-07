import { PostHog } from 'posthog-node';

let posthogClient;

export function getPostHogServer() {
  if (posthogClient !== undefined) return posthogClient;

  const apiKey = process.env.PUBLIC_POSTHOG_PROJECT_TOKEN;
  const host = process.env.PUBLIC_POSTHOG_HOST;

  if (!apiKey || !host) {
    if (process.env.NODE_ENV !== 'production') {
      const missingVariable = !apiKey ? 'PUBLIC_POSTHOG_PROJECT_TOKEN' : 'PUBLIC_POSTHOG_HOST';
      console.error(`${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`);
    }
    posthogClient = null;
    return posthogClient;
  }

  posthogClient = new PostHog(apiKey, {
    host,
    flushAt: 1,
    flushInterval: 0,
    enableExceptionAutocapture: true,
  });

  return posthogClient;
}
