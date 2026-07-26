import { expect } from 'chai';
import { matchesSearchQuery, parseSearchQuery } from '../../core/search-filter';

describe('parseSearchQuery', () => {
  it('treats empty/whitespace input as "no filter"', () => {
    expect(parseSearchQuery('')).to.deep.equal({ query: undefined, error: undefined });
    expect(parseSearchQuery('   ')).to.deep.equal({ query: undefined, error: undefined });
  });

  it('parses plain text as a name query', () => {
    const { query, error } = parseSearchQuery('auth');
    expect(error).to.be.undefined;
    expect(query).to.deep.equal({ mode: 'name', raw: 'auth' });
  });

  it('trims surrounding whitespace', () => {
    const { query } = parseSearchQuery('  auth  ');
    expect(query?.raw).to.equal('auth');
  });

  it('parses ext: into a lowercase, dot-stripped extension list', () => {
    const { query, error } = parseSearchQuery('ext:.TS, tsx ,js');
    expect(error).to.be.undefined;
    expect(query?.mode).to.equal('extension');
    expect(query?.extensions).to.deep.equal(['ts', 'tsx', 'js']);
  });

  it('errors on ext: with no extensions', () => {
    const { query, error } = parseSearchQuery('ext:');
    expect(query).to.be.undefined;
    expect(error).to.match(/requires at least one extension/);
  });

  it('errors on ext: with only commas/whitespace', () => {
    const { query, error } = parseSearchQuery('ext: , ,');
    expect(query).to.be.undefined;
    expect(error).to.match(/requires at least one extension/);
  });

  it('parses re: into a case-insensitive RegExp', () => {
    const { query, error } = parseSearchQuery('re:^use[A-Z]');
    expect(error).to.be.undefined;
    expect(query?.mode).to.equal('regex');
    expect(query?.regex?.test('useEffect.ts')).to.be.true;
    expect(query?.regex?.flags).to.include('i');
  });

  it('errors on an invalid regex without throwing', () => {
    const { query, error } = parseSearchQuery('re:(unclosed');
    expect(query).to.be.undefined;
    expect(error).to.match(/Invalid regex/);
  });

  it('is case-insensitive when detecting the ext:/re: prefixes', () => {
    expect(parseSearchQuery('EXT:ts').query?.mode).to.equal('extension');
    expect(parseSearchQuery('RE:^x').query?.mode).to.equal('regex');
  });
});

describe('matchesSearchQuery', () => {
  it('name mode: case-insensitive substring match against the relative path', () => {
    const { query } = parseSearchQuery('Auth');
    expect(matchesSearchQuery('src/auth/login.ts', 'login.ts', query!)).to.be.true;
    expect(matchesSearchQuery('src/payments/charge.ts', 'charge.ts', query!)).to.be.false;
  });

  it('extension mode: matches any extension in the list, case-insensitively', () => {
    const { query } = parseSearchQuery('ext:ts,tsx');
    expect(matchesSearchQuery('src/index.ts', 'index.ts', query!)).to.be.true;
    expect(matchesSearchQuery('src/Button.TSX', 'Button.TSX', query!)).to.be.true;
    expect(matchesSearchQuery('src/index.js', 'index.js', query!)).to.be.false;
  });

  it('extension mode: files with no extension never match', () => {
    const { query } = parseSearchQuery('ext:ts');
    expect(matchesSearchQuery('Dockerfile', 'Dockerfile', query!)).to.be.false;
  });

  it('regex mode: tests the relative path, not just the name', () => {
    const { query } = parseSearchQuery('re:^src/');
    expect(matchesSearchQuery('src/index.ts', 'index.ts', query!)).to.be.true;
    expect(matchesSearchQuery('dist/index.ts', 'index.ts', query!)).to.be.false;
  });
});
