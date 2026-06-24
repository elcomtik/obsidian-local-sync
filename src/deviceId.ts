export function createDeviceId(random: () => number = Math.random): string {
  return `device-${random().toString(16).slice(2)}`;
}

export function createReplacementDeviceId(
  currentDeviceId: string,
  random: () => number = Math.random,
): string {
  let replacement = createDeviceId(random);
  while (replacement === currentDeviceId) replacement = createDeviceId(random);
  return replacement;
}
