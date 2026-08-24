import { describe, it, expect } from 'vitest';
import { inferReceiverTypeAt, inferTypesFromSource } from './type-inference-engine.js';

describe('Python', () => {
  it('direct instantiation', () =>
    expect(inferTypesFromSource('service = MyService()\n', 'Python').get('service')).toBe('MyService'));
  it('type hint annotation', () =>
    expect(inferTypesFromSource('repo: UserRepo = get_repo()\n', 'Python').get('repo')).toBe('UserRepo'));
  it('annotated parameter', () =>
    expect(inferTypesFromSource('def run(svc: MyService): pass', 'Python').get('svc')).toBe('MyService'));
});

describe('C++', () => {
  it('explicit declaration', () =>
    expect(inferTypesFromSource('MyService svc;', 'C++').get('svc')).toBe('MyService'));
  it('pointer + new', () =>
    expect(inferTypesFromSource('MyService* svc = new MyService();', 'C++').get('svc')).toBe('MyService'));
  it('shared_ptr', () =>
    expect(inferTypesFromSource('shared_ptr<MyService> svc;', 'C++').get('svc')).toBe('MyService'));
  it('make_unique', () =>
    expect(inferTypesFromSource('auto svc = make_unique<MyService>();', 'C++').get('svc')).toBe('MyService'));
  it('make_shared', () =>
    expect(inferTypesFromSource('auto svc = make_shared<MyService>();', 'C++').get('svc')).toBe('MyService'));
});

describe('TypeScript', () => {
  it('const = new ClassName()', () =>
    expect(inferTypesFromSource('const svc = new MyService();', 'TypeScript').get('svc')).toBe('MyService'));
  it('type annotation', () =>
    expect(inferTypesFromSource('const svc: MyService = inject();', 'TypeScript').get('svc')).toBe('MyService'));
});

describe('JavaScript', () => {
  it('const = new ClassName()', () =>
    expect(inferTypesFromSource('const svc = new MyService();', 'JavaScript').get('svc')).toBe('MyService'));
});

describe('Go', () => {
  it('var declaration', () =>
    expect(inferTypesFromSource('var svc *MyService', 'Go').get('svc')).toBe('MyService'));
  it(':= struct literal', () =>
    expect(inferTypesFromSource('svc := MyService{}', 'Go').get('svc')).toBe('MyService'));
  it(':= address of struct', () =>
    expect(inferTypesFromSource('svc := &MyService{}', 'Go').get('svc')).toBe('MyService'));
});

describe('Rust', () => {
  it('let with type annotation', () =>
    expect(inferTypesFromSource('let svc: MyService = MyService::new();', 'Rust').get('svc')).toBe('MyService'));
  it('let inferred via ::new()', () =>
    expect(inferTypesFromSource('let svc = MyService::new();', 'Rust').get('svc')).toBe('MyService'));
  it('let inferred via ::default()', () =>
    expect(inferTypesFromSource('let svc = MyService::default();', 'Rust').get('svc')).toBe('MyService'));
});

describe('Java', () => {
  it('explicit declaration', () =>
    expect(inferTypesFromSource('MyService svc = new MyService();', 'Java').get('svc')).toBe('MyService'));
  it('interface var = new ConcreteClass — prefers concrete', () =>
    expect(inferTypesFromSource('IService svc = new MyService();', 'Java').get('svc')).toBe('MyService'));
  it('var x = new T() — Java 10+ local-variable type inference', () =>
    expect(inferTypesFromSource('var svc = new MyService();', 'Java').get('svc')).toBe('MyService'));
});

describe('C#', () => {
  it('explicit declaration', () =>
    expect(inferTypesFromSource('MyService svc = new MyService();', 'C#').get('svc')).toBe('MyService'));
  it('interface var = new ConcreteClass — prefers concrete', () =>
    expect(inferTypesFromSource('IService svc = new MyService();', 'C#').get('svc')).toBe('MyService'));
  it('var x = new T() — implicitly-typed local', () =>
    expect(inferTypesFromSource('var svc = new MyService();', 'C#').get('svc')).toBe('MyService'));
});

describe('Ruby', () => {
  it('.new call', () =>
    expect(inferTypesFromSource('svc = MyService.new', 'Ruby').get('svc')).toBe('MyService'));
});

describe('Kotlin', () => {
  it('explicit local annotation', () =>
    expect(inferTypesFromSource('val svc: MyService = provide()', 'Kotlin').get('svc')).toBe('MyService'));
  it('constructor assignment', () =>
    expect(inferTypesFromSource('val svc = MyService()', 'Kotlin').get('svc')).toBe('MyService'));
  it('constructor assignment prefers the concrete type', () =>
    expect(inferTypesFromSource('val svc: IService = MyService()', 'Kotlin').get('svc')).toBe('MyService'));
  it('ignores declarations in strings and nested comments', () => {
    const source = `val svc = RealService()\n"val svc = StringService()"\n/* outer /* val svc = NestedService() */ val svc = CommentService() */`;
    expect(inferTypesFromSource(source, 'Kotlin').get('svc')).toBe('RealService');
  });
  it('refuses a receiver name declared at multiple lexical sites', () => {
    const source = 'val p = A()\nrun { val p = B() }';
    expect(inferTypesFromSource(source, 'Kotlin').has('p')).toBe(false);
  });
});

describe('Dart', () => {
  it('explicit final local annotation', () =>
    expect(inferTypesFromSource('final MyService svc = provide();', 'Dart').get('svc')).toBe('MyService'));
  it('inferred final constructor assignment', () =>
    expect(inferTypesFromSource('final svc = MyService();', 'Dart').get('svc')).toBe('MyService'));
  it('constructor assignment prefers the concrete type', () =>
    expect(inferTypesFromSource('final IService svc = MyService();', 'Dart').get('svc')).toBe('MyService'));
  it('ignores declarations in strings and comments', () => {
    const source = `final svc = RealService();\n'final svc = StringService();'\n// final svc = LineService();\n/* final svc = BlockService(); */`;
    expect(inferTypesFromSource(source, 'Dart').get('svc')).toBe('RealService');
  });
  it('refuses a receiver name declared at multiple lexical sites', () => {
    const source = 'final p = A();\n{ final p = B(); }';
    expect(inferTypesFromSource(source, 'Dart').has('p')).toBe(false);
  });
});

describe('point-sensitive Kotlin/Dart receiver inference', () => {
  for (const language of ['Kotlin', 'Dart']) {
    const declaration = language === 'Kotlin' ? 'val p = Parser()' : 'final p = Parser();';
    it(`${language} does not use a declaration after the call`, () => {
      const source = `p.run(); ${declaration}`;
      expect(inferReceiverTypeAt(source, language, 'p', source.indexOf('p.run'))).toBeUndefined();
    });
    it(`${language} does not leak a nested binding after its block`, () => {
      const source = `{ ${declaration} } p.run();`;
      expect(inferReceiverTypeAt(source, language, 'p', source.indexOf('p.run'))).toBeUndefined();
    });
    it(`${language} refuses a receiver after reassignment`, () => {
      const source = `${declaration} p = Other(); p.run();`;
      expect(inferReceiverTypeAt(source, language, 'p', source.indexOf('p.run'))).toBeUndefined();
    });
  }
});

describe('unknown language', () => {
  it('returns empty map', () =>
    expect(inferTypesFromSource('x = Foo()', 'Cobol').size).toBe(0));
});
