import bcrypt from 'bcryptjs';

const COST = 10;

/** bcrypt hash, cost 10 (TECHNICAL_DESIGN §6.1). */
export const hashPassword = (plain) => bcrypt.hash(plain, COST);

export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);
