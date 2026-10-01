import 'server-only';

/**
 * Whether this deployment lets anyone with an email address start a venue (ROS_SELF_SERVE=1).
 * Off by default: a team hosting for its own venues onboards them from the platform console
 * and has no reason to offer sign-up to the internet. When off, /start is a 404.
 */
export function selfServeOpen(): boolean {
  return process.env.ROS_SELF_SERVE === '1';
}
