using System.Globalization;
using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// Bead's conversations, <c>spec/conversations.json</c>, played against the C# server of the
/// interop service: what its clients send, each on its own connection, what the server sends back
/// on each and reports, on a clock the conversation alone advances. The TypeScript server plays the
/// same file.
/// </summary>
public sealed class ConversationsTests
{
    // constants

    private static readonly JsonElement Root = Load();

    // where every conversation's wall clock starts
    private static readonly DateTimeOffset WallClock = DateTimeOffset.Parse(Root.GetProperty("wallClock").GetString()!, CultureInfo.InvariantCulture);

    // helpers

    private static JsonElement Load()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "conversations.json")));

        return document.RootElement.Clone();
    }

    private static JsonElement ConversationOf(string name)
    {
        foreach (var conversation in Root.GetProperty("conversations").EnumerateArray())
        {
            if (conversation.GetProperty("name").GetString() == name)
            {
                return conversation;
            }
        }

        throw new KeyNotFoundException($"no conversation \"{name}\"");
    }

    // definition

    /// <summary>The names of every conversation.</summary>
    public static TheoryData<string> Names { get; } = new(
        Root.GetProperty("conversations").EnumerateArray().Select((conversation) =>
        {
            return conversation.GetProperty("name").GetString()!;
        }));

    /// <summary>
    /// The names of every conversation a pair of the in-memory transport can stand for each
    /// connection of (<see cref="ConversationPlayer.CanStandFor"/>).
    /// </summary>
    public static TheoryData<string> InMemoryNames { get; } = new(
        Root.GetProperty("conversations").EnumerateArray().Where(ConversationPlayer.CanStandFor).Select((conversation) =>
        {
            return conversation.GetProperty("name").GetString()!;
        }));

    // * each conversation played through a transport the player scripts, which stands for any
    // connection
    [Theory]
    [MemberData(nameof(Names))]
    public async Task Plays(string name)
    {
        await ConversationPlayer.Play(ConversationOf(name), new PlayerOptions { WallClock = WallClock });
    }

    // spec 15.13: each conversation whose connections a pair of it stands for, through a real one
    [Theory]
    [MemberData(nameof(InMemoryNames))]
    public async Task Plays_through_the_in_memory_transport(string name)
    {
        await ConversationPlayer.Play(ConversationOf(name), new PlayerOptions { IsInMemory = true, WallClock = WallClock });
    }

    // spec 15.16 to 15.24: the same through a broker pair over the in-memory broker, whose
    // connection is secure and two-way and carries nothing toward its client, as an in-memory one
    [Theory]
    [MemberData(nameof(InMemoryNames))]
    public async Task Plays_through_a_broker_pair(string name)
    {
        await ConversationPlayer.Play(ConversationOf(name), new PlayerOptions { IsOverBroker = true, WallClock = WallClock });
    }
}
