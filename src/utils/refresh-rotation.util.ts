export async function rotateRefreshTokenAtomically(
  compareAndSet: (key: string, expected: string, replacement: string, ttlSeconds: number) => Promise<boolean>,
  userId: string,
  currentToken: string,
  nextToken: string,
  ttlSeconds: number
): Promise<boolean> {
  return compareAndSet(`refresh:${userId}`, currentToken, nextToken, ttlSeconds);
}
