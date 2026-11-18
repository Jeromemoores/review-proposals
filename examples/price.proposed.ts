export function totalCents(unitCents: number, quantity: number): number {
  return unitCents * quantity;
}

export function formatTotal(unitCents: number, quantity: number): string {
  return `$${(totalCents(unitCents, quantity) / 100).toFixed(2)}`;
}
