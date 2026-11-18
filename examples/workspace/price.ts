export function formatTotal(unitCents: number, quantity: number): string {
  const total = unitCents * quantity;
  return `$${(total / 100).toFixed(2)}`;
}
