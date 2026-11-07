/**
 * The protobuf projection through the real CallGraphBuilder (change: add-contract-graph-projection,
 * protobuf phase).
 *
 * One `.proto` file and a Go, a Python and a Node (grpc-js) server, each registering its
 * implementation: the RPC nodes land in the graph, each server's method gets an
 * `implements_endpoint` edge, a test file's fake registration binds nothing, and — as for every
 * projected declaration — code fan-in/fan-out, hubs and entry points are unchanged.
 */
import { describe, it, expect } from 'vitest';
import { CallGraphBuilder } from '../call-graph.js';

const PROTO = `syntax = "proto3";
package orders.v1;

service OrderService {
  rpc GetOrder(GetOrderRequest) returns (Order);
}
service PaymentService {
  rpc Charge(Order) returns (Order);
}
service InventoryService {
  rpc Reserve(Order) returns (Order);
}

message GetOrderRequest { string id = 1; }
message Order { string id = 1; }
`;

const GO = `package main

import (
	"google.golang.org/grpc"
	pb "example.com/orders/v1"
)

type orderServer struct {
	pb.UnimplementedOrderServiceServer
}

func (s *orderServer) GetOrder(ctx context.Context, req *pb.GetOrderRequest) (*pb.Order, error) {
	return lookup(req.Id), nil
}

func lookup(id string) *pb.Order {
	return &pb.Order{Id: id}
}

func main() {
	s := grpc.NewServer()
	pb.RegisterOrderServiceServer(s, &orderServer{})
}
`;

const PY = `import grpc
from orders.v1 import orders_pb2_grpc


class PaymentServicer(orders_pb2_grpc.PaymentServiceServicer):
    def Charge(self, request, context):
        return settle(request)


def settle(order):
    return order


def serve():
    server = grpc.server(None)
    orders_pb2_grpc.add_PaymentServiceServicer_to_server(PaymentServicer(), server)
    server.start()
`;

const JS = `const grpc = require('@grpc/grpc-js');

function reserveStock(call, callback) {
  callback(null, call.request);
}

function main(proto) {
  const server = new grpc.Server();
  server.addService(proto.orders.v1.InventoryService.service, { reserve: reserveStock });
}

module.exports = { main };
`;

const GO_TEST = `package main

type fakeServer struct{}

func (f *fakeServer) GetOrder() {}

func TestServer(t *testing.T) {
	pb.RegisterOrderServiceServer(s, &fakeServer{})
}
`;

const CODE = [
  { path: 'cmd/server/main.go', content: GO, language: 'Go' },
  { path: 'cmd/server/main_test.go', content: GO_TEST, language: 'Go' },
  { path: 'payments/server.py', content: PY, language: 'Python' },
  { path: 'inventory/server.js', content: JS, language: 'JavaScript' },
];

const build = (withProto: boolean) =>
  new CallGraphBuilder(withProto ? { contractFiles: [{ path: 'proto/orders.proto', content: PROTO }] } : {}).build(CODE);

describe('protobuf projection through the builder', () => {
  it('binds the Go, Python and Node implementations to the RPCs they serve', async () => {
    const result = await build(true);
    const rpcs = [...result.nodes.values()].filter(n => n.language === 'Protobuf' && n.name.startsWith('/'));
    expect(rpcs.map(n => n.name).sort()).toEqual([
      '/orders.v1.InventoryService/Reserve', '/orders.v1.OrderService/GetOrder', '/orders.v1.PaymentService/Charge',
    ]);
    const bound = result.edges
      .filter(e => e.kind === 'implements_endpoint')
      .map(e => {
        const from = result.nodes.get(e.callerId)!;
        return `${from.filePath} ${from.className ? `${from.className}.` : ''}${from.name} -> ${result.nodes.get(e.calleeId)!.name}`;
      })
      .sort();
    expect(bound).toEqual([
      'cmd/server/main.go orderServer.GetOrder -> /orders.v1.OrderService/GetOrder',
      'inventory/server.js reserveStock -> /orders.v1.InventoryService/Reserve',
      'payments/server.py PaymentServicer.Charge -> /orders.v1.PaymentService/Charge',
    ]);
    // The test file's fake registration binds nothing.
    expect(result.edges.some(e => e.callerId.includes('main_test.go') && e.kind === 'implements_endpoint')).toBe(false);
    expect(result.contracts?.unboundRpcs.total ?? 0).toBe(0);
    expect(result.contracts?.unresolvedRegistrations.total ?? 0).toBe(0);
  });

  it('draws references_schema edges between the projected declarations', async () => {
    const result = await build(true);
    const refs = result.edges.filter(e => e.kind === 'references_schema').map(e => `${result.nodes.get(e.callerId)?.name} -> ${result.nodes.get(e.calleeId)?.name}`);
    expect(refs).toContain('/orders.v1.OrderService/GetOrder -> orders.v1.GetOrderRequest');
    expect(refs).toContain('/orders.v1.OrderService/GetOrder -> orders.v1.Order');
  });

  it('leaves code fan-in, fan-out, hubs, entry points and averages untouched', async () => {
    const withProto = await build(true);
    const bare = await build(false);
    const metrics = (r: Awaited<ReturnType<typeof build>>) =>
      [...r.nodes.values()].filter(n => n.language !== 'Protobuf').map(n => `${n.id} ${n.fanIn}/${n.fanOut}`).sort();
    expect(metrics(withProto)).toEqual(metrics(bare));
    expect(withProto.hubFunctions.some(n => n.language === 'Protobuf')).toBe(false);
    expect(withProto.entryPoints.some(n => n.language === 'Protobuf')).toBe(false);
    expect(withProto.entryPoints.map(n => n.id).sort()).toEqual(bare.entryPoints.map(n => n.id).sort());
    expect(withProto.stats.avgFanIn).toBe(bare.stats.avgFanIn);
    expect(withProto.stats.avgFanOut).toBe(bare.stats.avgFanOut);
  });
});
