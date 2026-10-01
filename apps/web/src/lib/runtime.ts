import 'server-only';
import { getRuntime } from '@ros/runtime';
import type { App } from '@ros/core';
// Registers Next's tag revalidation with the website module, once, wherever server code runs.
import './site-revalidate';

/** The application for this process. Server code only. */
export function app(): App {
  return getRuntime().app;
}

/** Simulated providers, or null when running against real ones. For development tools only. */
export function sim() {
  return getRuntime().sim;
}
