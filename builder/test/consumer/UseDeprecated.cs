// ── A consumer of what is deprecated ──────────────────────────────────────────

// Each use a consumer makes of what the C# target marks, over the goldens: the caller's and the
// implementer's, who must still serve a deprecated procedure. `Bead.Goldens.Tests` compiles it with
// the goldens, every warning a warning: the line under one that says `// reported:` and a
// diagnostic's text is reported so, BEAD0001, and every other line is not, the controls among them.
// Never run. The TypeScript target's twin is `use-deprecated.ts`, beside it.

using Bead.Comments.V1;
using Bead.Messages.V1;

namespace Bead.Goldens.Consumer;

/// <summary>Each use a consumer makes of what the C# target marks.</summary>
public static class UseDeprecated
{
    /// <summary>The caller's uses: a requester, a descriptor, a notification, a failure told.</summary>
    public static object?[] CallerUses(GreeterClient client, global::Bead.FailureException exception)
    {
        return
        [
            // reported: 'GreeterClient.Watch' is obsolete: 'Use sayHello.'
            client.Watch,
            // reported: 'GreeterProcedures.Watch' is obsolete: 'Use sayHello.'
            GreeterProcedures.Watch,
            // reported: 'GreeterNotifications.Watch.get' is obsolete: 'Use sayHello.'
            client.Notifications.Watch,
            // reported: 'CommentsFailures.Block.Late' is obsolete: 'No replacement is named.'
            CommentsFailures.Is(exception, CommentsFailures.Block.Late),
            // the controls: nothing of theirs is deprecated, a message protobuf deprecates aside
            client.SayHello,
            client.SayGoodbye,
            GreeterProcedures.SayHello,
            CommentsFailures.Is(exception, CommentsFailures.Block.Early),
        ];
    }

    /// <summary>The implementer's uses: a resolver registered, a command's requester, a notifier.</summary>
    public static object?[] ImplementerUses(GreeterServer<object> server, CommentsServer<object> comments)
    {
        // reported: 'GreeterProcedures.Watch' is obsolete: 'Use sayHello.'
        server.On(GreeterProcedures.Watch, null!);
        // reported: 'CommentsProcedures.Trailing' is obsolete: 'Use escapes.'
        comments.On(CommentsProcedures.Trailing, null!);
        // the control: a procedure nothing deprecates
        server.On(GreeterProcedures.SayHello, null!);

        return
        [
            // reported: 'GreeterCommands.Name.get' is obsolete: 'No replacement is named.'
            server.Command.Name,
            // reported: 'GreeterNotifiers.Watch.get' is obsolete: 'Use sayHello.'
            server.Notify.Watch,
        ];
    }

    /// <summary>A window, by its member.</summary>
    public static GreeterWindows Windows()
    {
        return new GreeterWindows
        {
            // reported: 'GreeterWindows.Watch' is obsolete: 'Use sayHello.'
            Watch = 5,
        };
    }

    /// <summary>A deprecated service's types, each marked as its service is.</summary>
    public static object?[] ServiceUses(global::Bead.IClient client)
    {
        return
        [
            // reported: 'OldCommentsClient' is obsolete: 'Use CommentsService.'
            new OldCommentsClient(client),
            // reported: 'OldCommentsProcedures' is obsolete: 'Use CommentsService.'
            OldCommentsProcedures.All,
        ];
    }
}
