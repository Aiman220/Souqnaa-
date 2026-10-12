import bcrypt from 'bcryptjs';

export interface PasswordValidationResult {
  valid: boolean;
  errors: string[];
}

const COMMON_WEAK_PASSWORDS = new Set([
  'password12345',
  'admin12345678',
  'admin@1234567',
  'administrator1',
  'qwerty1234567',
  '123456789012',
  'welcome123456',
  'souqna1234567',
]);

export class PasswordPolicyUtil {
  public static readonly MIN_ADMIN_LENGTH = 12;
  public static readonly BCRYPT_SALT_ROUNDS = 12;

  /**
   * Enforces strict enterprise password policy for administrator accounts:
   * - Minimum 12 characters
   * - At least one uppercase letter (A-Z)
   * - At least one lowercase letter (a-z)
   * - At least one numeric digit (0-9)
   * - At least one special symbol (!@#$%^&*...)
   * - Disallows common dictionary/weak passwords
   */
  public static validateAdminPassword(password: string): PasswordValidationResult {
    const errors: string[] = [];

    if (!password || typeof password !== 'string') {
      return { valid: false, errors: ['كلمة المرور مطلوبة'] };
    }

    if (password.length < this.MIN_ADMIN_LENGTH) {
      errors.push(`يجب أن تتكون كلمة المرور من ${this.MIN_ADMIN_LENGTH} حرفاً على الأقل`);
    }

    if (!/[A-Z]/.test(password)) {
      errors.push('يجب أن تحتوي كلمة المرور على حرف كبير واحد على الأقل (A-Z)');
    }

    if (!/[a-z]/.test(password)) {
      errors.push('يجب أن تحتوي كلمة المرور على حرف صغير واحد على الأقل (a-z)');
    }

    if (!/[0-9]/.test(password)) {
      errors.push('يجب أن تحتوي كلمة المرور على رقم واحد على الأقل (0-9)');
    }

    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(password)) {
      errors.push('يجب أن تحتوي كلمة المرور على رمز خاص واحد على الأقل (!@#$%^&*)');
    }

    if (COMMON_WEAK_PASSWORDS.has(password.toLowerCase())) {
      errors.push('كلمة المرور شائعة جداً وسهلة التخمين، يرجى اختيار كلمة مرور أقوى');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Hashes a password using bcrypt with 12 salt rounds
   */
  public static async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, this.BCRYPT_SALT_ROUNDS);
  }

  /**
   * Verifies a candidate plaintext password against a stored bcrypt hash
   */
  public static async verifyPassword(candidate: string, hash: string): Promise<boolean> {
    return bcrypt.compare(candidate, hash);
  }
}
