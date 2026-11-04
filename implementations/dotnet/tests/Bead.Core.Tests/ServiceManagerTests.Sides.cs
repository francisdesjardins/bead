using System.Reflection;

namespace Bead.Tests;

public sealed partial class ServiceManagerTests
{
    // spec 16.11
    [Fact]
    public void Types_a_client_s_services_and_a_server_s_by_their_side_each_without_the_other_s_makers()
    {
        // * each side's type holds its side's makers alone, so another side's does not compile
        Assert.Equal(["GetCommandResolver", "GetNotification", "GetRequest"], MakersOf(typeof(IServiceManagerClient)));
        Assert.Equal(["GetCommand", "GetNotificationResolver", "GetRequestResolver"], MakersOf(typeof(IServiceManagerServer)));
        Assert.Equal(typeof(IServiceManagerClient), typeof(IClient).GetProperty(nameof(IClient.Services))!.PropertyType);
        Assert.Equal(typeof(IServiceManagerServer), typeof(IBeadServer<string>).GetProperty(nameof(IBeadServer<string>.Services))!.PropertyType);
        Assert.Equal(typeof(IServiceManagerServer), typeof(Server<string>).GetProperty(nameof(Server<string>.Services))!.PropertyType);

        // a server's services hear no notification dropped, and no assembly but Bead's implements either
        Assert.NotNull(typeof(IServiceManagerClient).GetEvent(nameof(ServiceManager.Dropped)));
        Assert.Null(typeof(IServiceManagerServer).GetEvent(nameof(ServiceManager.Dropped)));
        Assert.All([typeof(IServiceManagerClient), typeof(IServiceManagerServer)], (side) =>
        {
            Assert.Contains(side.GetProperties(BindingFlags.Instance | BindingFlags.NonPublic), (property) =>
            {
                return property.GetMethod is { IsAssembly: true, IsAbstract: true };
            });
        });

        // past the types, the one manager is still refused as it is made
        IServiceManagerClient client = new ServiceManager(new RecordingRouter(RouterSide.Client));
        IServiceManagerServer server = new ServiceManager(new RecordingRouter(RouterSide.Server));

        var commanded = Assert.Throws<InvalidOperationException>(() =>
        {
            _ = ((IServiceManagerServer)client).GetCommand(Echo, Asked);
        });
        var requested = Assert.Throws<InvalidOperationException>(() =>
        {
            _ = ((IServiceManagerClient)server).GetRequest(Echo, Asked);
        });

        Assert.Equal("a client's router makes requests: GetRequest", commanded.Message);
        Assert.Equal("a server's router makes commands: GetCommand", requested.Message);
    }

    // the makers a type of manager declares, by name
    private static string[] MakersOf(Type type)
    {
        return [.. type.GetMethods().Select((method) =>
        {
            return method.Name;
        }).Where((name) =>
        {
            return name.StartsWith("Get", StringComparison.Ordinal);
        }).Order(StringComparer.Ordinal)];
    }
}
