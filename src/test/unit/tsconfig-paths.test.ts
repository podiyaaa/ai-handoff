import { expect } from 'chai';
import { matchPathAlias, parseTsconfigPaths, stripJsonComments } from '../../core/tsconfig-paths';

describe('stripJsonComments', () => {
  it('strips // line comments', () => {
    const text = `{\n  "a": 1, // a comment\n  "b": 2\n}`;
    expect(JSON.parse(stripJsonComments(text))).to.deep.equal({ a: 1, b: 2 });
  });

  it('strips /* */ block comments, including multiline ones', () => {
    const text = `{\n  /* leading\n     comment */\n  "a": 1\n}`;
    expect(JSON.parse(stripJsonComments(text))).to.deep.equal({ a: 1 });
  });

  it('strips trailing commas before } and ]', () => {
    const text = `{\n  "a": [1, 2, 3,],\n  "b": 2,\n}`;
    expect(JSON.parse(stripJsonComments(text))).to.deep.equal({ a: [1, 2, 3], b: 2 });
  });

  it('does not touch // or /* inside string values', () => {
    const text = `{ "url": "https://example.com/*not-a-comment*/" }`;
    expect(JSON.parse(stripJsonComments(text))).to.deep.equal({ url: 'https://example.com/*not-a-comment*/' });
  });

  it('handles escaped quotes inside strings without ending the string early', () => {
    const text = `{ "note": "she said \\"hi\\" // not a comment" }`;
    expect(JSON.parse(stripJsonComments(text))).to.deep.equal({ note: 'she said "hi" // not a comment' });
  });

  it('handles a combination of comments and trailing commas together', () => {
    const text = [
      '{',
      '  // top comment',
      '  "compilerOptions": {',
      '    "baseUrl": ".", /* base */',
      '    "paths": {',
      '      "@app/*": ["src/app/*"],',
      '    },',
      '  },',
      '}',
    ].join('\n');
    expect(JSON.parse(stripJsonComments(text))).to.deep.equal({
      compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/app/*'] } },
    });
  });
});

describe('parseTsconfigPaths', () => {
  it('parses baseUrl and paths from compilerOptions', () => {
    const text = `{
      "compilerOptions": {
        "baseUrl": ".",
        "paths": { "@app/*": ["src/app/*"] }
      }
    }`;
    const result = parseTsconfigPaths(text);
    expect(result?.config).to.deep.equal({ baseUrl: '.', paths: { '@app/*': ['src/app/*'] } });
    expect(result?.extends).to.be.undefined;
  });

  it('parses the extends value as a raw, unresolved string', () => {
    const text = `{ "extends": "./tsconfig.base.json", "compilerOptions": {} }`;
    const result = parseTsconfigPaths(text);
    expect(result?.extends).to.equal('./tsconfig.base.json');
    expect(result?.config).to.deep.equal({});
  });

  it('tolerates JSONC comments and trailing commas (real-world tsconfig style)', () => {
    const text = `{
      // comment
      "compilerOptions": {
        "baseUrl": "./src", /* trailing */
        "paths": {
          "@app/*": ["app/*"],
        },
      },
    }`;
    const result = parseTsconfigPaths(text);
    expect(result?.config.baseUrl).to.equal('./src');
    expect(result?.config.paths).to.deep.equal({ '@app/*': ['app/*'] });
  });

  it('returns a config with no baseUrl/paths when compilerOptions is absent', () => {
    const result = parseTsconfigPaths(`{ "include": ["src"] }`);
    expect(result?.config).to.deep.equal({});
  });

  it('returns undefined for invalid JSON', () => {
    expect(parseTsconfigPaths('{ not valid json')).to.be.undefined;
  });

  it('returns undefined for a top-level JSON array', () => {
    expect(parseTsconfigPaths('[1, 2, 3]')).to.be.undefined;
  });

  it('ignores non-array values under paths', () => {
    const text = `{ "compilerOptions": { "paths": { "@app/*": "not-an-array" } } }`;
    const result = parseTsconfigPaths(text);
    expect(result?.config.paths).to.deep.equal({});
  });
});

describe('matchPathAlias', () => {
  it('matches a wildcard pattern and substitutes the captured segment', () => {
    const paths = { '@app/*': ['src/app/*'] };
    expect(matchPathAlias('@app/button', paths)).to.deep.equal(['src/app/button']);
  });

  it('returns every target for a pattern with multiple fallbacks', () => {
    const paths = { '@app/*': ['src/app/*', 'legacy/app/*'] };
    expect(matchPathAlias('@app/button', paths)).to.deep.equal(['src/app/button', 'legacy/app/button']);
  });

  it('returns [] when no pattern matches', () => {
    expect(matchPathAlias('react', { '@app/*': ['src/app/*'] })).to.deep.equal([]);
  });

  it('an exact (non-wildcard) key always wins over a wildcard pattern', () => {
    const paths = {
      '@app/special': ['src/special-cased.ts'],
      '@app/*': ['src/app/*'],
    };
    expect(matchPathAlias('@app/special', paths)).to.deep.equal(['src/special-cased.ts']);
  });

  it('picks the longest-prefix-matching pattern when multiple wildcards could match', () => {
    const paths = {
      '@app/*': ['src/app/*'],
      '@app/widgets/*': ['src/widgets/*'],
    };
    expect(matchPathAlias('@app/widgets/button', paths)).to.deep.equal(['src/widgets/button']);
  });

  it('respects a wildcard suffix, not just a prefix', () => {
    const paths = { '*/index': ['generated/*/index'] };
    expect(matchPathAlias('foo/index', paths)).to.deep.equal(['generated/foo/index']);
    expect(matchPathAlias('foo/other', paths)).to.deep.equal([]);
  });

  it('handles a bare (non-wildcard) pattern with no matching specifier', () => {
    expect(matchPathAlias('unrelated', { exact: ['src/exact.ts'] })).to.deep.equal([]);
  });
});
