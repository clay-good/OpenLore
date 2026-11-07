import { describe, it, expect } from 'vitest';
import { readProtobuf, resolveProtoTypes, type ProtoDocument } from '../../analyzer/contract/protobuf.js';
import { diffProtobuf } from './protobuf-diff.js';
import { contractBump } from './contract-diff.js';

const side = (files: Record<string, string>): ProtoDocument[] => resolveProtoTypes(Object.entries(files).map(([file, text]) => {
  const r = readProtobuf(file, text);
  if ('error' in r) throw new Error(`${file}: ${r.error}`);
  return r;
})).docs;

const BASE = `syntax = "proto3";
package orders.v1;

import "google/protobuf/timestamp.proto";

message Order {
  string id = 1;
  int64 total = 2;
  repeated string tags = 3;
  Status status = 4;
  google.protobuf.Timestamp created = 5;
  optional string note = 6;
  oneof payment { string card = 7; string iban = 8; }
  reserved 10 to 12, 20;
  reserved "legacy";
}

enum Status {
  STATUS_UNSPECIFIED = 0;
  STATUS_OPEN = 1;
  STATUS_SHIPPED = 2;
  reserved 9;
}

message GetOrderRequest { string id = 1; }

service OrderService {
  rpc GetOrder(GetOrderRequest) returns (Order);
  rpc WatchOrders(GetOrderRequest) returns (stream Order);
  rpc DeleteOrder(GetOrderRequest) returns (Order);
}
`;

const diff = (head: string, base = BASE) => diffProtobuf(side({ 'orders.proto': base }), side({ 'orders.proto': head }));
const rules = (head: string) => diff(head).map(c => `${c.rule} ${c.address}${c.element ? ` ${c.element}` : ''}`);

describe('diffProtobuf', () => {
  it('no change: no verdicts; comments, whitespace and declaration order are not changes', () => {
    expect(diff(BASE)).toEqual([]);
    const reordered = BASE.replace('message GetOrderRequest { string id = 1; }\n', '')
      .replace('package orders.v1;', 'package orders.v1;\n// moved\nmessage GetOrderRequest {\n  string id = 1; // the id\n}');
    expect(diff(reordered)).toEqual([]);
  });

  it('a field is matched by number: a rename is dangerous, a new number is breaking', () => {
    expect(rules(BASE.replace('string id = 1;\n  int64', 'string order_id = 1;\n  int64'))).toEqual(['field-renamed orders.v1.Order field 1 (order_id)']);
    expect(rules(BASE.replace('int64 total = 2;', 'int64 total = 9;'))).toEqual(['field-number-changed orders.v1.Order field 9 (total)']);
  });

  it('field type, label, presence, oneof and deprecation', () => {
    expect(rules(BASE.replace('int64 total = 2;', 'int32 total = 2;'))).toEqual(['field-type-changed orders.v1.Order field 2 (total)']);
    expect(rules(BASE.replace('repeated string tags = 3;', 'string tags = 3;'))).toEqual(['field-label-changed orders.v1.Order field 3 (tags)']);
    expect(rules(BASE.replace('optional string note = 6;', 'string note = 6;'))).toEqual(['field-presence-changed orders.v1.Order field 6 (note)']);
    expect(rules(BASE.replace('oneof payment { string card = 7; string iban = 8; }', 'string card = 7;\n  oneof payment { string iban = 8; }'))).toEqual(['field-oneof-changed orders.v1.Order field 7 (card)']);
    expect(rules(BASE.replace('int64 total = 2;', 'int64 total = 2 [deprecated = true];'))).toEqual(['field-deprecated orders.v1.Order field 2 (total)']);
    expect(rules(BASE.replace('int64 total = 2;', 'int64 total = 2 [json_name = "sum"];'))).toEqual(['schema-unassessed orders.v1.Order field 2 (total)']);
  });

  it('a removed field is breaking unless its number is reserved', () => {
    expect(rules(BASE.replace('  int64 total = 2;\n', ''))).toEqual(['field-removed orders.v1.Order field 2 (total)']);
    expect(rules(BASE.replace('  int64 total = 2;\n', '').replace('reserved 10 to 12, 20;', 'reserved 2, 10 to 12, 20;')))
      .toEqual(['field-removed-reserved orders.v1.Order field 2 (total)']);
  });

  it('reusing a reserved number or name is breaking; dropping a reservation is dangerous', () => {
    // A head that reuses a number must also drop its reservation (protoc refuses otherwise).
    expect(rules(BASE.replace('string id = 1;\n  int64', 'string id = 1;\n  string coupon = 11;\n  int64').replace('reserved 10 to 12, 20;', 'reserved 10, 12, 20;')))
      .toEqual(['reserved-number-reused orders.v1.Order field 11 (coupon)', 'reserved-removed orders.v1.Order']);
    expect(rules(BASE.replace('string id = 1;\n  int64', 'string id = 1;\n  string legacy = 30;\n  int64').replace('reserved "legacy";', '')))
      .toEqual(['reserved-number-reused orders.v1.Order field 30 (legacy)', 'reserved-removed orders.v1.Order']);
    const dropped = diff(BASE.replace('reserved 10 to 12, 20;', 'reserved 10, 20;'));
    expect(dropped.map(c => c.rule)).toEqual(['reserved-removed']);
    expect(dropped[0].detail).toContain('11 to 12');
  });

  it('a type referenced by a different name that resolves to the same type is no change', () => {
    expect(diff(BASE.replace('Status status = 4;', '.orders.v1.Status status = 4;'))).toEqual([]);
    expect(rules(BASE.replace('Status status = 4;', 'GetOrderRequest status = 4;'))).toEqual(['field-type-changed orders.v1.Order field 4 (status)']);
  });

  it('a type that resolves on neither side is compared as written, never called changed by guess', () => {
    // `google.protobuf.Timestamp` is imported from outside the repository on both sides.
    expect(diff(BASE)).toEqual([]);
    expect(rules(BASE.replace('google.protobuf.Timestamp created = 5;', 'Timestamp created = 5;'))).toEqual(['schema-unassessed orders.v1.Order field 5 (created)']);
  });

  it('enums: removed, reserved, added, renumbered', () => {
    expect(rules(BASE.replace('  STATUS_SHIPPED = 2;\n', ''))).toEqual(['enum-value-removed orders.v1.Status STATUS_SHIPPED']);
    expect(rules(BASE.replace('  STATUS_SHIPPED = 2;\n', '').replace('reserved 9;', 'reserved 2, 9;'))).toEqual(['enum-value-removed-reserved orders.v1.Status STATUS_SHIPPED']);
    expect(rules(BASE.replace('STATUS_SHIPPED = 2;', 'STATUS_SHIPPED = 2;\n  STATUS_LOST = 3;'))).toEqual(['enum-value-added orders.v1.Status STATUS_LOST']);
    expect(rules(BASE.replace('STATUS_SHIPPED = 2;', 'STATUS_SHIPPED = 5;'))).toEqual(['enum-value-number-changed orders.v1.Status STATUS_SHIPPED']);
    expect(rules(BASE.replace('STATUS_SHIPPED = 2;', 'STATUS_SHIPPED = 2;\n  STATUS_X = 9;'))).toEqual(['reserved-number-reused orders.v1.Status STATUS_X']);
  });

  it('RPCs: removed, added, deprecated, retyped, streaming changed', () => {
    expect(rules(BASE.replace('  rpc DeleteOrder(GetOrderRequest) returns (Order);\n', ''))).toEqual(['rpc-removed /orders.v1.OrderService/DeleteOrder']);
    expect(rules(BASE.replace('rpc DeleteOrder(GetOrderRequest) returns (Order);', 'rpc DeleteOrder(GetOrderRequest) returns (Order);\n  rpc Ping(GetOrderRequest) returns (GetOrderRequest);')))
      .toEqual(['rpc-added /orders.v1.OrderService/Ping']);
    expect(rules(BASE.replace('rpc DeleteOrder(GetOrderRequest) returns (Order);', 'rpc DeleteOrder(GetOrderRequest) returns (Order) { option deprecated = true; }')))
      .toEqual(['rpc-deprecated /orders.v1.OrderService/DeleteOrder']);
    expect(rules(BASE.replace('rpc DeleteOrder(GetOrderRequest) returns (Order);', 'rpc DeleteOrder(GetOrderRequest) returns (GetOrderRequest);')))
      .toEqual(['rpc-type-changed /orders.v1.OrderService/DeleteOrder response']);
    expect(rules(BASE.replace('returns (stream Order)', 'returns (Order)'))).toEqual(['rpc-streaming-changed /orders.v1.OrderService/WatchOrders']);
  });

  it('messages and enums: removed is breaking, added is not; a move between files is no change', () => {
    const extra = BASE.replace('message GetOrderRequest', 'message Refund { string id = 1; }\n\nmessage GetOrderRequest');
    expect(rules(extra)).toEqual(['type-added orders.v1.Refund']);
    expect(diffProtobuf(side({ 'orders.proto': extra }), side({ 'orders.proto': BASE })).map(c => c.rule)).toEqual(['type-removed']);
    const split = {
      'orders.proto': BASE.replace('message GetOrderRequest { string id = 1; }\n', '').replace('import "google/protobuf/timestamp.proto";', 'import "google/protobuf/timestamp.proto";\nimport "requests.proto";'),
      'requests.proto': 'syntax = "proto3";\npackage orders.v1;\nmessage GetOrderRequest { string id = 1; }\n',
    };
    expect(diffProtobuf(side({ 'orders.proto': BASE }), side(split))).toEqual([]);
  });

  it('a renamed package removes and adds everything (the wire names changed)', () => {
    const r = diff(BASE.replace('package orders.v1;', 'package orders.v2;'));
    expect(r.filter(c => c.rule === 'rpc-removed')).toHaveLength(3);
    expect(contractBump(r)).toBe('major');
  });

  it('bumps: additions only are minor; nothing is patch', () => {
    expect(contractBump(diff(BASE.replace('STATUS_SHIPPED = 2;', 'STATUS_SHIPPED = 2;\n  STATUS_LOST = 3;')))).toBe('minor');
    expect(contractBump(diff(BASE))).toBe('patch');
    expect(contractBump(diff(BASE.replace('int64 total = 2;', 'int64 total = 2 [json_name = "sum"];')))).toBeNull();
  });

  it('a type declared in two files is compared as a set', () => {
    const dup = 'syntax = "proto3";\npackage orders.v1;\nmessage Dup { string a = 1; }\n';
    const before = side({ 'a.proto': dup, 'b.proto': dup });
    expect(diffProtobuf(before, side({ 'a.proto': dup, 'b.proto': dup }))).toEqual([]);
    const changed = diffProtobuf(before, side({ 'a.proto': dup, 'b.proto': dup.replace('string a', 'int32 a') }));
    expect(changed.map(c => c.rule)).toEqual(['schema-unassessed']);
  });
});

describe('diffProtobuf: round-1 review regressions', () => {
  const msg = (body: string) => `syntax = "proto3";\npackage p;\n${body}\n`;
  const r = (b: string, h: string) => diffProtobuf(side({ 'x.proto': msg(b) }), side({ 'x.proto': msg(h) })).map(c => `${c.rule}${c.element ? ` ${c.element}` : ''}`);

  it('a swap of two fields\' numbers is two number changes, never two renames', () => {
    expect(r('message M { string a = 1; string b = 2; }', 'message M { string a = 2; string b = 1; }'))
      .toEqual(['field-number-changed field 1 (b)', 'field-number-changed field 2 (a)']);
  });

  it('a field moved to a new number with its old number refilled is a number change', () => {
    expect(r('message M { string a = 1; }', 'message M { string b = 1; string a = 2; }'))
      .toEqual(['field-added field 1 (b)', 'field-number-changed field 2 (a)']);
  });

  it('a number dropped from the middle of a large reserved range is seen', () => {
    const d = diffProtobuf(side({ 'x.proto': msg('message M { reserved 1 to 1000; }') }), side({ 'x.proto': msg('message M { reserved 1 to 499, 501 to 1000; }') }));
    expect(d.map(c => c.rule)).toEqual(['reserved-removed']);
    expect(d[0].detail).toContain('500');
    const max = diffProtobuf(side({ 'x.proto': msg('message M { reserved 100 to max; }') }), side({ 'x.proto': msg('message M { reserved 100 to 200, 300 to max; }') }));
    expect(max[0].detail).toContain('201 to 299');
  });

  it('comparing many reservations is linear, not quadratic', () => {
    const many = `message M { reserved ${Array.from({ length: 20_000 }, (_, i) => `${i * 100 + 1} to ${i * 100 + 65}`).join(', ')}; }`;
    const t = Date.now();
    expect(diffProtobuf(side({ 'x.proto': msg(many) }), side({ 'x.proto': msg(many) }))).toEqual([]);
    expect(Date.now() - t).toBeLessThan(2_000);
  });

  it('enum value options and deprecation are compared; service options too', () => {
    expect(r('enum E { A = 0; B = 1; }', 'enum E { A = 0; B = 1 [deprecated = true]; }')).toEqual(['enum-value-deprecated B']);
    expect(r('enum E { A = 0; B = 1; }', 'enum E { A = 0; B = 1 [(x) = 3]; }')).toEqual(['schema-unassessed B']);
    expect(r('message Q {}\nservice S { rpc X(Q) returns (Q); }', 'message Q {}\nservice S { option deprecated = true; rpc X(Q) returns (Q); }')).toEqual(['schema-unassessed']);
  });

  it('an enum value removed with only its NAME reserved is breaking; a rename is dangerous', () => {
    expect(r('enum E { A = 0; B = 1; }', 'enum E { A = 0; reserved "B"; }')).toEqual(['enum-value-removed B']);
    expect(r('enum E { A = 0; B = 1; }', 'enum E { A = 0; C = 1; }')).toEqual(['enum-value-renamed B']);
  });

  it('renaming a oneof is not a change; moving a field out of it is', () => {
    expect(r('message M { oneof o { int32 a = 1; int32 b = 2; } }', 'message M { oneof q { int32 a = 1; int32 b = 2; } }')).toEqual([]);
    expect(r('message M { oneof o { int32 a = 1; int32 b = 2; } }', 'message M { int32 a = 1; oneof o { int32 b = 2; } }')).toEqual(['field-oneof-changed field 1 (a)']);
  });

  it('string escapes are decoded: "\\x61" is the reserved name "a"', () => {
    expect(r('message M { reserved "a"; }', 'message M { reserved "\\x61"; }')).toEqual([]);
  });

  it('both rpc type changes carry their side as the element', () => {
    expect(r('message A {}\nmessage B {}\nservice S { rpc X(A) returns (A); }', 'message A {}\nmessage B {}\nservice S { rpc X(B) returns (B); }'))
      .toEqual(['rpc-type-changed request', 'rpc-type-changed response']);
  });
});

describe('diffProtobuf: round-2 review regressions', () => {
  const msg = (body: string) => `syntax = "proto3";\npackage p;\n${body}\n`;
  const r = (b: string, h: string) => diffProtobuf(side({ 'x.proto': msg(b) }), side({ 'x.proto': msg(h) })).map(c => `${c.rule}${c.element ? ` ${c.element}` : ''}`);

  it('two oneofs merged into one is a change for both members', () => {
    expect(r('message M { oneof x { int32 a = 1; } oneof w { int32 b = 2; } }', 'message M { oneof y { int32 a = 1; int32 b = 2; } }'))
      .toEqual(['field-oneof-changed field 1 (a)', 'field-oneof-changed field 2 (b)']);
  });

  it('a field removed while another moves onto its number is reported removed', () => {
    expect(r('message M { string a = 1; string b = 2; }', 'message M { string a = 2; }'))
      .toEqual(['field-number-changed field 2 (a)', 'field-removed field 2 (b)']);
  });

  it('a new alias on a number in use is an addition', () => {
    expect(r('enum E { option allow_alias = true; A = 0; B = 1; }', 'enum E { option allow_alias = true; A = 0; B = 1; C = 1; }')).toEqual(['enum-value-added C']);
  });
});
