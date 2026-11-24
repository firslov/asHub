export const tokenPattern = /[a-z0-9]+(?:[-_.:/][a-z0-9]+)*/g;
const version = /^v?(\d+\.\d+\.\d+(?:-[a-z0-9][a-z0-9.-]*)?)$/;
const address = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?(?:\/.*)?$/;
function tokenValues(token, includeHost) {
  const endpoint=address.exec(token);
  if(endpoint && endpoint[1].split('.').every(part=>Number(part)<=255) && (!endpoint[2] || Number(endpoint[2])<=65535)){
    const host=endpoint[1],port=endpoint[2];
    return port ? [host+':'+port,...(includeHost?[host]:[])] : [host];
  }
  return token.split('/').filter(part=>/\d/.test(part)).map(part=>version.exec(part)?.[1]??part);
}
export const valueTokens = (value, includeHost=false) => (value.normalize('NFKC').toLowerCase().match(tokenPattern) ?? [])
  .flatMap(token=>tokenValues(token,includeHost));
export const isIdentifier = token => /[a-z]/.test(token) || /^\d{3,}$|^\d+(?:[._:/-]\d+)+$/.test(token);
export const identifiers = (value, includeHost=false) => valueTokens(value,includeHost).filter(isIdentifier);
