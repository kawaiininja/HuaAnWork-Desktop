/** 与 sidecar `auth.*` 同一套长度规则；注册还要求两次密码一致。 */
export function authFormReady(creating: boolean, username: string, password: string, confirm: string): boolean {
  const nameLen = [...username.trim()].length;
  if (nameLen < 2 || nameLen > 32) return false;
  if ([...password].length < 8) return false;
  if (creating && password !== confirm) return false;
  return true;
}
