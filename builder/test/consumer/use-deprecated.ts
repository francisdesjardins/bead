// ── A consumer of what is deprecated ──────────────────────────────────────────

// Each use a consumer makes of what the TypeScript target marks, over the goldens: the caller's and
// the implementer's, who must still serve a deprecated procedure. The target's test lints it with
// `typescript/no-deprecated` alone, type-aware: the line under one that says `// reported:` and a
// report's text is reported so, and every other line is not, the controls among them. Never run;
// `yarn type-check` compiles it, so each callback taken through a deprecated overload stays typed.
// The C# target's twin is `UseDeprecated.cs`, beside it.

// dependencies

import {
  CommentsFailures,
  OldCommentsClient,
  OldCommentsProcedures,
  type OldCommentsResolvers,
} from '../golden/typescript/bead/comments/v1/comments_bead.ts';
import {
  GreeterClient,
  GreeterProcedures,
  type GreeterResolvers,
  GreeterServer,
  type GreeterWindows,
} from '../golden/typescript/bead/messages/v1/messages_bead.ts';

// types

declare const beadClient: ConstructorParameters<typeof GreeterClient>[0];

// definition

/** The caller's uses: a requester, a descriptor, a notification, a failure made and told. */
export const callerUses = (error: unknown): readonly unknown[] => {
  const client = new GreeterClient(beadClient);

  return [
    // reported: `watch` is deprecated. Use sayHello.
    client.watch({ name: 'a' }),
    // reported: `watch` is deprecated. Use sayHello.
    GreeterProcedures.watch,
    // reported: `watch` is deprecated. Use sayHello.
    client.notifications.watch,
    // reported: `of` is deprecated. No replacement is named.
    CommentsFailures.of('LATE'),
    // reported: `is` is deprecated. No replacement is named.
    CommentsFailures.is(error, 'LATE'),
    // the controls: nothing of theirs is deprecated, a message protobuf deprecates aside
    client.sayHello({ name: 'b' }),
    client.sayGoodbye({ name: 'c' }),
    GreeterProcedures.sayHello,
    CommentsFailures.of('EARLY'),
    CommentsFailures.is(error, 'EARLY'),
  ];
};

/** The implementer's uses: a command's requester, a notifier, a resolver by its name and its key. */
export const implementerUses = (): readonly unknown[] => {
  const server = new GreeterServer();
  const client = new GreeterClient(beadClient);

  // reported: `on` is deprecated. Use sayHello.
  server.on('watch', async (request, response) => {
    const name: string = request.payload.name;
    // @ts-expect-error: a name is no number, the request typed through the deprecated overload
    const wrong: number = request.payload.name;

    void wrong;
    await response({ name });
  });
  // reported: `on` is deprecated. No replacement is named.
  client.on('name', async (request, response) => {
    const asked: string = request.payload;
    // @ts-expect-error: a text is no number, the request typed through the deprecated overload
    const wrong: number = request.payload;

    void wrong;
    await response({ name: asked });
  });
  // the control: a name nothing deprecates takes the layer's own signature
  server.on('sayHello', async (request, response) => {
    await response({ text: request.payload.name });
  });

  return [
    // reported: `name` is deprecated. No replacement is named.
    server.command.name,
    // reported: `watch` is deprecated. Use sayHello.
    server.notify.watch,
  ];
};

/** A resolver by its key, and a window by its key. */
export const resolvers: Partial<GreeterResolvers> = {
  // reported: `watch` is deprecated. Use sayHello.
  watch: async (request, response) => {
    await response({ name: request.payload.name });
  },
};

// reported: `watch` is deprecated. Use sayHello.
export const windows: GreeterWindows = { watch: 5 };

/** A deprecated service's types, each marked through its parent's deprecation. */
export const serviceUses = (): readonly unknown[] => {
  // reported: `OldCommentsClient` is deprecated. Use CommentsService.
  const old = new OldCommentsClient(beadClient);
  // reported: `OldCommentsResolvers` is deprecated. Use CommentsService.
  const escapes: OldCommentsResolvers['escapes'] | undefined = undefined;

  // a constant's report names no reason: the lint reads none off its statement's doc comment
  // reported: `OldCommentsProcedures` is deprecated.
  return [old, escapes, OldCommentsProcedures];
};
