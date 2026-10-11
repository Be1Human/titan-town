// Return the velocity after a nearby explosion without changing the player.
// Movement and collision remain the responsibility of stepPlayer.
export function calculateBlastVelocity(player, point, {
  radius = 5,
  push = 7,
  lift = 4.5,
  cover = 1,
  maxHorizontalSpeed = 10,
  maxRiseSpeed = 6,
} = {}) {
  const dx = player.x - point.x;
  const dz = player.z - point.z;
  const dy = player.y + 1 - point.y;
  const distance = Math.hypot(dx, dy, dz);
  if (!(radius > 0) || !Number.isFinite(distance) || distance >= radius) return null;

  const exposure = Math.max(0, Math.min(1, cover));
  if (!exposure) return null;
  const proximity = 1 - distance / radius;
  const strength = proximity * proximity * (3 - 2 * proximity) * exposure;
  const horizontalDistance = Math.hypot(dx, dz);
  let vx = (player.vx || 0) + (horizontalDistance ? dx / horizontalDistance * push * strength : 0);
  let vz = (player.vz || 0) + (horizontalDistance ? dz / horizontalDistance * push * strength : 0);
  const horizontalSpeed = Math.hypot(vx, vz);
  if (horizontalSpeed > maxHorizontalSpeed) {
    const scale = maxHorizontalSpeed / horizontalSpeed;
    vx *= scale;
    vz *= scale;
  }
  const vy = Math.min(maxRiseSpeed, (player.vy || 0) + lift * strength);
  return {vx, vy, vz, grounded: vy > 0 ? false : player.grounded};
}
