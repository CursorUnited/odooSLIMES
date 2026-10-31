/**
 * Row-level scoping (TECHNICAL_DESIGN §6.3): a CUSTOMER only ever sees rows of
 * their own customer record. Other roles get `where` unchanged.
 */
export function scopeToCustomer(user, where = {}) {
  if (user?.role !== 'CUSTOMER') return where;
  return { ...where, customerId: user.customerId ?? -1 };
}

export const isCustomer = (user) => user?.role === 'CUSTOMER';
