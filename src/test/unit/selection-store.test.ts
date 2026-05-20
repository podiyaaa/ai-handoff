import { expect } from 'chai';
import { InMemoryMemento, SelectionStore } from '../../services/selection-store';

describe('SelectionStore — last selection', () => {
  it('returns undefined when nothing has been saved', () => {
    const store = new SelectionStore(new InMemoryMemento());
    expect(store.getLastSelection()).to.be.undefined;
  });

  it('round-trips a saved selection', async () => {
    const store = new SelectionStore(new InMemoryMemento());
    await store.setLastSelection(['src/a.ts', 'README.md']);
    // Stored sorted, so order is canonical
    expect(store.getLastSelection()).to.deep.equal(['README.md', 'src/a.ts']);
  });

  it('overwrites on subsequent saves', async () => {
    const store = new SelectionStore(new InMemoryMemento());
    await store.setLastSelection(['a.ts']);
    await store.setLastSelection(['b.ts', 'c.ts']);
    expect(store.getLastSelection()).to.deep.equal(['b.ts', 'c.ts']);
  });

  it('persists an empty selection (cleared state)', async () => {
    const store = new SelectionStore(new InMemoryMemento());
    await store.setLastSelection([]);
    expect(store.getLastSelection()).to.deep.equal([]);
  });

  it('clears the saved selection', async () => {
    const store = new SelectionStore(new InMemoryMemento());
    await store.setLastSelection(['a.ts']);
    await store.clearLastSelection();
    expect(store.getLastSelection()).to.be.undefined;
  });
});

describe('SelectionStore — named sets', () => {
  it('starts empty', () => {
    const store = new SelectionStore(new InMemoryMemento());
    expect(store.listSetNames()).to.deep.equal([]);
    expect(store.listNamedSets()).to.deep.equal({});
    expect(store.getNamedSet('anything')).to.be.undefined;
  });

  it('saves and retrieves a named set', async () => {
    const store = new SelectionStore(new InMemoryMemento());
    await store.saveNamedSet('Auth module', ['src/auth/login.ts', 'src/auth/signup.ts']);
    expect(store.getNamedSet('Auth module')).to.deep.equal([
      'src/auth/login.ts',
      'src/auth/signup.ts',
    ]);
  });

  it('lists multiple sets alphabetically', async () => {
    const store = new SelectionStore(new InMemoryMemento());
    await store.saveNamedSet('Zeta', ['z.ts']);
    await store.saveNamedSet('Alpha', ['a.ts']);
    await store.saveNamedSet('Mu', ['m.ts']);
    expect(store.listSetNames()).to.deep.equal(['Alpha', 'Mu', 'Zeta']);
  });

  it('overwrites when saving the same name twice', async () => {
    const store = new SelectionStore(new InMemoryMemento());
    await store.saveNamedSet('Frontend', ['App.tsx']);
    await store.saveNamedSet('Frontend', ['App.tsx', 'Header.tsx']);
    expect(store.getNamedSet('Frontend')).to.deep.equal(['App.tsx', 'Header.tsx']);
    expect(store.listSetNames()).to.deep.equal(['Frontend']);
  });

  it('trims whitespace in names', async () => {
    const store = new SelectionStore(new InMemoryMemento());
    await store.saveNamedSet('  Padded  ', ['a.ts']);
    expect(store.getNamedSet('Padded')).to.deep.equal(['a.ts']);
  });

  it('rejects empty names', async () => {
    const store = new SelectionStore(new InMemoryMemento());
    let threw = false;
    try {
      await store.saveNamedSet('   ', ['a.ts']);
    } catch (e) {
      threw = true;
      expect((e as Error).message).to.include('cannot be empty');
    }
    expect(threw).to.be.true;
  });

  it('deletes a named set', async () => {
    const store = new SelectionStore(new InMemoryMemento());
    await store.saveNamedSet('Temp', ['a.ts']);
    await store.deleteNamedSet('Temp');
    expect(store.getNamedSet('Temp')).to.be.undefined;
    expect(store.listSetNames()).to.deep.equal([]);
  });

  it('delete is a no-op on missing names', async () => {
    const store = new SelectionStore(new InMemoryMemento());
    await store.saveNamedSet('Real', ['a.ts']);
    await store.deleteNamedSet('Ghost');
    expect(store.listSetNames()).to.deep.equal(['Real']);
  });

  it('clears all named sets', async () => {
    const store = new SelectionStore(new InMemoryMemento());
    await store.saveNamedSet('A', ['a.ts']);
    await store.saveNamedSet('B', ['b.ts']);
    await store.clearAllNamedSets();
    expect(store.listSetNames()).to.deep.equal([]);
  });

  it('keeps last selection separate from named sets', async () => {
    const store = new SelectionStore(new InMemoryMemento());
    await store.setLastSelection(['recent.ts']);
    await store.saveNamedSet('Pinned', ['pinned.ts']);
    expect(store.getLastSelection()).to.deep.equal(['recent.ts']);
    expect(store.getNamedSet('Pinned')).to.deep.equal(['pinned.ts']);
  });

  it('listNamedSets returns paths in stored (sorted) order', async () => {
    const store = new SelectionStore(new InMemoryMemento());
    await store.saveNamedSet('S', ['z.ts', 'a.ts', 'm.ts']);
    const all = store.listNamedSets();
    expect(all['S']).to.deep.equal(['a.ts', 'm.ts', 'z.ts']);
  });
});

describe('InMemoryMemento', () => {
  it('returns undefined for missing keys', () => {
    const m = new InMemoryMemento();
    expect(m.get('missing')).to.be.undefined;
  });

  it('honors the defaultValue overload', () => {
    const m = new InMemoryMemento();
    expect(m.get('missing', 'fallback')).to.equal('fallback');
  });

  it('round-trips primitive values', async () => {
    const m = new InMemoryMemento();
    await m.update('k', 42);
    expect(m.get('k')).to.equal(42);
  });

  it('deep-copies objects on write', async () => {
    const m = new InMemoryMemento();
    const obj = { foo: 'bar', nested: { x: 1 } };
    await m.update('k', obj);
    obj.nested.x = 999;
    expect((m.get('k') as typeof obj).nested.x).to.equal(1);
  });

  it('deletes key when value is undefined', async () => {
    const m = new InMemoryMemento();
    await m.update('k', 'hi');
    await m.update('k', undefined);
    expect(m.get('k')).to.be.undefined;
    expect(m.keys()).to.not.include('k');
  });
});
