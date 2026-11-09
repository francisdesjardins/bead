using System.Text.Json;
using Bead.Subsets.V1;

namespace Bead.Goldens.Tests;

/// <summary>
/// The goldens' split output, <c>subsets/</c>, as Bead.Goldens compiles it (decision 0048): its
/// server class holds the procedures it serves, and refuses as it is registered the resolver of
/// any other, which the TypeScript target's server class refuses at its type-check, in
/// <c>typescript.test.ts</c>.
/// </summary>
public sealed class SubsetsTests
{
    [Fact]
    public void A_server_class_refuses_a_resolver_of_a_procedure_it_does_not_serve()
    {
        // * no hook named: audit's, auditor, is a procedure called here, not served
        var server = new ShopServer<object>();
        ServiceResolverCallback<JsonElement, JsonElement, NoFailure> callback = (request, response) =>
        {
            return response.Answer(request.Payload);
        };

        server.On(ShopProcedures.PlaceOrder, callback);

        var refusal = Assert.Throws<ArgumentException>(() =>
        {
            server.On(ShopProcedures.ListOrders, callback);
        });

        Assert.Equal("listOrders is no procedure of this service (Parameter 'procedure')", refusal.Message);
    }
}
