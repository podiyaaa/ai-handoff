import { expect } from 'chai';
import {
  FilterChain,
  formatBytes,
  getExtension,
  isBinary,
  isBinaryByContent,
  isBinaryByExtension,
  parseSearchExcludeDirs,
  BINARY_EXTENSIONS,
  DEFAULT_SMART_FILTER_PATTERNS,
} from '../../core/filter';

describe('getExtension', () => {
  it('returns lowercase extension with leading dot', () => {
    expect(getExtension('foo.TXT')).to.equal('.txt');
    expect(getExtension('image.PNG')).to.equal('.png');
  });

  it('handles paths with directories', () => {
    expect(getExtension('src/foo.ts')).to.equal('.ts');
    expect(getExtension('a/b/c/file.js')).to.equal('.js');
  });

  it('returns empty string when no extension', () => {
    expect(getExtension('README')).to.equal('');
    expect(getExtension('src/Makefile')).to.equal('');
  });

  it('handles dotfiles correctly (no extension)', () => {
    expect(getExtension('.gitignore')).to.equal('');
    expect(getExtension('src/.env')).to.equal('');
  });

  it('handles multiple dots — only the last counts', () => {
    expect(getExtension('app.config.json')).to.equal('.json');
    expect(getExtension('archive.tar.gz')).to.equal('.gz');
  });

  it('handles windows-style separators', () => {
    expect(getExtension('src\\foo.ts')).to.equal('.ts');
  });
});

describe('isBinaryByExtension', () => {
  it('detects common image extensions', () => {
    expect(isBinaryByExtension('logo.png')).to.be.true;
    expect(isBinaryByExtension('photo.JPG')).to.be.true;
    expect(isBinaryByExtension('icon.gif')).to.be.true;
  });

  it('detects archives, fonts, executables', () => {
    expect(isBinaryByExtension('bundle.zip')).to.be.true;
    expect(isBinaryByExtension('font.woff2')).to.be.true;
    expect(isBinaryByExtension('app.exe')).to.be.true;
    expect(isBinaryByExtension('module.so')).to.be.true;
  });

  it('returns false for source code files', () => {
    expect(isBinaryByExtension('index.ts')).to.be.false;
    expect(isBinaryByExtension('App.tsx')).to.be.false;
    expect(isBinaryByExtension('script.py')).to.be.false;
    expect(isBinaryByExtension('main.rs')).to.be.false;
  });

  it('returns false for text files without extension', () => {
    expect(isBinaryByExtension('README')).to.be.false;
    expect(isBinaryByExtension('Dockerfile')).to.be.false;
  });
});

describe('isBinaryByContent', () => {
  it('detects binary by presence of NUL bytes', () => {
    const buf = Buffer.from([0x48, 0x65, 0x6c, 0x00, 0x6f]);
    expect(isBinaryByContent(buf)).to.be.true;
  });

  it('returns false for pure ASCII', () => {
    const buf = Buffer.from('Hello, world!\nThis is plain text.');
    expect(isBinaryByContent(buf)).to.be.false;
  });

  it('returns false for UTF-8 with multi-byte chars', () => {
    const buf = Buffer.from('café — résumé — 日本語', 'utf-8');
    expect(isBinaryByContent(buf)).to.be.false;
  });

  it('respects the sample size — large file, NUL after sample window', () => {
    const buf = Buffer.alloc(10000, 0x41); // 10K of 'A'
    buf[9999] = 0x00; // NUL at the end
    expect(isBinaryByContent(buf, 100)).to.be.false; // sample missed it
    expect(isBinaryByContent(buf, 10000)).to.be.true; // full scan caught it
  });

  it('handles empty buffer', () => {
    expect(isBinaryByContent(Buffer.alloc(0))).to.be.false;
  });
});

describe('isBinary (combined)', () => {
  it('returns true on extension match without needing buffer', () => {
    expect(isBinary('logo.png')).to.be.true;
  });

  it('uses buffer when extension is ambiguous', () => {
    const textBuf = Buffer.from('hello world');
    const binaryBuf = Buffer.from([0x00, 0x01, 0x02]);
    expect(isBinary('mystery', textBuf)).to.be.false;
    expect(isBinary('mystery', binaryBuf)).to.be.true;
  });

  it('returns false when no extension match and no buffer given', () => {
    expect(isBinary('mystery')).to.be.false;
  });
});

describe('FilterChain — smart filter', () => {
  function chain(smartFilter = true) {
    return new FilterChain({
      smartFilter,
      respectGitignore: false,
      customIgnorePatterns: [],
      maxFileSizeKB: 1024,
    });
  }

  it('rejects node_modules paths', () => {
    const result = chain().decide({
      relativePath: 'node_modules/lodash/index.js',
      sizeBytes: 1000,
    });
    expect(result.include).to.be.false;
    if (!result.include) {
      expect(result.reason).to.equal('smart-filter');
    }
  });

  it('rejects .git paths', () => {
    const result = chain().decide({
      relativePath: '.git/HEAD',
      sizeBytes: 50,
    });
    expect(result.include).to.be.false;
  });

  it('rejects dist/ and build/', () => {
    expect(
      chain().decide({ relativePath: 'dist/bundle.js', sizeBytes: 100 }).include,
    ).to.be.false;
    expect(
      chain().decide({ relativePath: 'build/output.exe', sizeBytes: 100 }).include,
    ).to.be.false;
  });

  it('rejects lock files', () => {
    expect(
      chain().decide({ relativePath: 'package-lock.json', sizeBytes: 100 }).include,
    ).to.be.false;
    expect(
      chain().decide({ relativePath: 'yarn.lock', sizeBytes: 100 }).include,
    ).to.be.false;
  });

  it('allows source files through', () => {
    expect(
      chain().decide({ relativePath: 'src/index.ts', sizeBytes: 1000 }).include,
    ).to.be.true;
    expect(
      chain().decide({ relativePath: 'README.md', sizeBytes: 1000 }).include,
    ).to.be.true;
  });

  it('does nothing when smartFilter is disabled', () => {
    const result = chain(false).decide({
      relativePath: 'node_modules/lodash/index.js',
      sizeBytes: 1000,
    });
    expect(result.include).to.be.true;
  });
});

describe('FilterChain — gitignore', () => {
  function chain(gitignoreContent: string) {
    return new FilterChain({
      smartFilter: false,
      respectGitignore: true,
      gitignoreContent,
      customIgnorePatterns: [],
      maxFileSizeKB: 1024,
    });
  }

  it('respects simple patterns', () => {
    const c = chain('*.log\nsecret/\n');
    expect(c.decide({ relativePath: 'app.log', sizeBytes: 100 }).include).to.be.false;
    expect(c.decide({ relativePath: 'secret/token.txt', sizeBytes: 100 }).include).to.be.false;
    expect(c.decide({ relativePath: 'app.ts', sizeBytes: 100 }).include).to.be.true;
  });

  it('respects negation patterns', () => {
    const c = chain('*.log\n!important.log\n');
    expect(c.decide({ relativePath: 'app.log', sizeBytes: 100 }).include).to.be.false;
    expect(c.decide({ relativePath: 'important.log', sizeBytes: 100 }).include).to.be.true;
  });

  it('returns the gitignore reason', () => {
    const c = chain('*.log\n');
    const result = c.decide({ relativePath: 'app.log', sizeBytes: 100 });
    expect(result.include).to.be.false;
    if (!result.include) {
      expect(result.reason).to.equal('gitignore');
    }
  });

  it('skips gitignore when no content provided', () => {
    const c = new FilterChain({
      smartFilter: false,
      respectGitignore: true,
      gitignoreContent: undefined,
      customIgnorePatterns: [],
      maxFileSizeKB: 1024,
    });
    expect(c.decide({ relativePath: 'whatever.log', sizeBytes: 100 }).include).to.be.true;
  });
});

describe('FilterChain — custom ignore', () => {
  it('respects custom glob patterns', () => {
    const c = new FilterChain({
      smartFilter: false,
      respectGitignore: false,
      customIgnorePatterns: ['**/*.tmp', '**/scratch/**'],
      maxFileSizeKB: 1024,
    });
    expect(c.decide({ relativePath: 'src/scratch/draft.ts', sizeBytes: 100 }).include).to.be.false;
    expect(c.decide({ relativePath: 'src/file.tmp', sizeBytes: 100 }).include).to.be.false;
    expect(c.decide({ relativePath: 'src/file.ts', sizeBytes: 100 }).include).to.be.true;
  });

  it('returns custom-ignore reason', () => {
    const c = new FilterChain({
      smartFilter: false,
      respectGitignore: false,
      customIgnorePatterns: ['**/*.tmp'],
      maxFileSizeKB: 1024,
    });
    const result = c.decide({ relativePath: 'foo.tmp', sizeBytes: 100 });
    expect(result.include).to.be.false;
    if (!result.include) {
      expect(result.reason).to.equal('custom-ignore');
    }
  });
});

describe('FilterChain — size limit', () => {
  it('rejects files over the limit', () => {
    const c = new FilterChain({
      smartFilter: false,
      respectGitignore: false,
      customIgnorePatterns: [],
      maxFileSizeKB: 1, // 1KB limit
    });
    const result = c.decide({ relativePath: 'big.txt', sizeBytes: 2048 });
    expect(result.include).to.be.false;
    if (!result.include) {
      expect(result.reason).to.equal('too-large');
      expect(result.detail).to.match(/2\.0 KB/);
      expect(result.detail).to.match(/1 KB limit/);
    }
  });

  it('allows files exactly at the limit', () => {
    const c = new FilterChain({
      smartFilter: false,
      respectGitignore: false,
      customIgnorePatterns: [],
      maxFileSizeKB: 1,
    });
    expect(c.decide({ relativePath: 'exact.txt', sizeBytes: 1024 }).include).to.be.true;
  });

  it('size limit applies even to overridden files (safety)', () => {
    const c = new FilterChain({
      smartFilter: true,
      respectGitignore: false,
      customIgnorePatterns: [],
      maxFileSizeKB: 1,
    });
    // Override bypasses smart filter, but NOT size limit.
    const result = c.decide({
      relativePath: 'node_modules/huge.js',
      sizeBytes: 5_000_000,
      isOverridden: true,
    });
    expect(result.include).to.be.false;
    if (!result.include) {
      expect(result.reason).to.equal('too-large');
    }
  });
});

describe('FilterChain — overrides', () => {
  it('overrides bypass smart filter', () => {
    const c = new FilterChain({
      smartFilter: true,
      respectGitignore: false,
      customIgnorePatterns: [],
      maxFileSizeKB: 1024,
    });
    const result = c.decide({
      relativePath: 'node_modules/x/index.js',
      sizeBytes: 100,
      isOverridden: true,
    });
    expect(result.include).to.be.true;
  });

  it('overrides bypass gitignore', () => {
    const c = new FilterChain({
      smartFilter: false,
      respectGitignore: true,
      gitignoreContent: '*.secret',
      customIgnorePatterns: [],
      maxFileSizeKB: 1024,
    });
    const result = c.decide({
      relativePath: 'my.secret',
      sizeBytes: 100,
      isOverridden: true,
    });
    expect(result.include).to.be.true;
  });

  it('overrides bypass custom patterns', () => {
    const c = new FilterChain({
      smartFilter: false,
      respectGitignore: false,
      customIgnorePatterns: ['**/*.tmp'],
      maxFileSizeKB: 1024,
    });
    const result = c.decide({
      relativePath: 'foo.tmp',
      sizeBytes: 100,
      isOverridden: true,
    });
    expect(result.include).to.be.true;
  });
});

describe('FilterChain — ordering', () => {
  it('returns smart-filter reason before gitignore reason', () => {
    // node_modules/foo.log: matches BOTH smart filter (node_modules/) and gitignore (*.log).
    // Smart filter runs first.
    const c = new FilterChain({
      smartFilter: true,
      respectGitignore: true,
      gitignoreContent: '*.log',
      customIgnorePatterns: [],
      maxFileSizeKB: 1024,
    });
    const result = c.decide({ relativePath: 'node_modules/foo.log', sizeBytes: 100 });
    expect(result.include).to.be.false;
    if (!result.include) {
      expect(result.reason).to.equal('smart-filter');
    }
  });
});

describe('formatBytes', () => {
  it('formats bytes', () => {
    expect(formatBytes(0)).to.equal('0 B');
    expect(formatBytes(523)).to.equal('523 B');
    expect(formatBytes(1023)).to.equal('1023 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).to.equal('1.0 KB');
    expect(formatBytes(1536)).to.equal('1.5 KB');
    expect(formatBytes(1024 * 999)).to.equal('999.0 KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(1024 * 1024)).to.equal('1.0 MB');
    expect(formatBytes(1024 * 1024 * 4.5)).to.equal('4.5 MB');
  });

  it('formats gigabytes', () => {
    expect(formatBytes(1024 * 1024 * 1024)).to.equal('1.0 GB');
    expect(formatBytes(1024 * 1024 * 1024 * 2.3)).to.equal('2.3 GB');
  });
});

describe('parseSearchExcludeDirs', () => {
  it('splits a comma-separated list and trims whitespace', () => {
    expect(parseSearchExcludeDirs('vendor, coverage , generated')).to.deep.equal([
      'vendor/',
      'coverage/',
      'generated/',
    ]);
  });

  it('appends a trailing slash so it matches directories, not same-named files', () => {
    expect(parseSearchExcludeDirs('vendor')).to.deep.equal(['vendor/']);
  });

  it('leaves an already-trailing-slash pattern untouched', () => {
    expect(parseSearchExcludeDirs('vendor/')).to.deep.equal(['vendor/']);
  });

  it('preserves wildcard glob patterns', () => {
    expect(parseSearchExcludeDirs('**/generated,*.egg-info')).to.deep.equal([
      '**/generated/',
      '*.egg-info/',
    ]);
  });

  it('drops empty entries from blank/whitespace-only segments', () => {
    expect(parseSearchExcludeDirs('vendor,,  ,coverage')).to.deep.equal(['vendor/', 'coverage/']);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseSearchExcludeDirs('')).to.deep.equal([]);
  });

  it('returns an empty array for a whitespace-only string', () => {
    expect(parseSearchExcludeDirs('   ')).to.deep.equal([]);
  });
});

describe('exported constants', () => {
  it('DEFAULT_SMART_FILTER_PATTERNS is non-empty', () => {
    expect(DEFAULT_SMART_FILTER_PATTERNS.length).to.be.greaterThan(10);
  });

  it('BINARY_EXTENSIONS is non-empty', () => {
    expect(BINARY_EXTENSIONS.size).to.be.greaterThan(20);
    expect(BINARY_EXTENSIONS.has('.png')).to.be.true;
    expect(BINARY_EXTENSIONS.has('.exe')).to.be.true;
  });
});
