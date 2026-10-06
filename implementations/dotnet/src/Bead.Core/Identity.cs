using System.Globalization;

namespace Bead;

/// <summary>The ways a procedure is declared to a router, each taking the kinds spec 16.11 gives it.</summary>
internal enum DeclarationWay
{
    /// <summary>A resolver registered on a client's router: it takes a command.</summary>
    ClientResolver,

    /// <summary>A resolver registered on a server's router that notifies nothing: it takes a request.</summary>
    ServerResolver,

    /// <summary>A resolver registered on a server's router that notifies: it takes a request that notifies.</summary>
    ServerNotificationResolver,

    /// <summary>A requester made on a client's router: it takes a request, and a request that notifies.</summary>
    ClientRequester,

    /// <summary>A requester made on a server's router: it takes a command.</summary>
    ServerRequester,

    /// <summary>A notification registered on a client's router: it takes a request that notifies.</summary>
    ClientNotification,
}

/// <summary>
/// What a side refuses as a procedure is declared to it (spec 16.10): a service id, a procedure id
/// or a revision out of its range, then a name off its form, then a kind the way it is declared does
/// not take; and which two names are one (16.6). One check of the procedure alone, which holds
/// nothing: each router runs it first, before any reason of its own and before its registry's.
/// </summary>
internal static class Identity
{
    // constants

    // the characters a procedure's name holds at most (16.4)
    private const int LongestName = 63;

    // helpers

    private static bool IsLower(char character)
    {
        return character is >= 'a' and <= 'z';
    }

    private static bool IsUpper(char character)
    {
        return character is >= 'A' and <= 'Z';
    }

    private static bool IsDigit(char character)
    {
        return character is >= '0' and <= '9';
    }

    // ! an ASCII upper-case letter read as its lower-case one, and nothing else: a fold that sets
    // 0x20 on any character would make @ and ` one, and a platform's own would make the Kelvin sign k
    private static char Folded(char character)
    {
        return IsUpper(character) ? (char)(character + ('a' - 'A')) : character;
    }

    // what a procedure's kind is, in a refusal's sentence
    internal static string WordsOf(ProcedureKind procedureKind)
    {
        return procedureKind switch
        {
            ProcedureKind.Request => "a request",
            ProcedureKind.Notifies => "a request that notifies",
            _ => "a command",
        };
    }

    // what a way is, and the kinds it takes (16.11)
    private static (string Way, ProcedureKind[] Takes) WayOf(DeclarationWay way)
    {
        return way switch
        {
            DeclarationWay.ClientResolver => ("a resolver on a client's router", [ProcedureKind.Command]),
            DeclarationWay.ServerResolver => ("a resolver on a server's router that notifies nothing", [ProcedureKind.Request]),
            DeclarationWay.ServerNotificationResolver => ("a resolver on a server's router that notifies", [ProcedureKind.Notifies]),
            DeclarationWay.ClientRequester => ("a requester on a client's router", [ProcedureKind.Request, ProcedureKind.Notifies]),
            DeclarationWay.ServerRequester => ("a requester on a server's router", [ProcedureKind.Command]),
            _ => ("a notification on a client's router", [ProcedureKind.Notifies]),
        };
    }

    // definition

    /// <summary>The way a resolver is declared to a router of <paramref name="side"/>: one that notifies, or not.</summary>
    public static DeclarationWay ResolverWayOf(RouterSide side, bool notifies)
    {
        if (side == RouterSide.Client)
        {
            return DeclarationWay.ClientResolver;
        }

        return notifies ? DeclarationWay.ServerNotificationResolver : DeclarationWay.ServerResolver;
    }

    /// <summary>
    /// Whether <paramref name="name"/> is a procedure's name (16.4): a lower-case ASCII letter, then
    /// up to 62 ASCII letters or digits, read character by character (16.5), never by a regular
    /// expression, whose <c>$</c> may let a line terminator by, nor by a case mapping.
    /// </summary>
    public static bool IsProcedureName(string name)
    {
        ArgumentNullException.ThrowIfNull(name);

        if (name.Length is 0 or > LongestName || !IsLower(name[0]))
        {
            return false;
        }

        for (var index = 1; index < name.Length; index += 1)
        {
            var character = name[index];

            if (!IsLower(character) && !IsUpper(character) && !IsDigit(character))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Whether two names are one (16.6): equal once each ASCII upper-case letter is read as its
    /// lower-case one, compared character by character, and no string built.
    /// </summary>
    public static bool AreOneName(string name, string other)
    {
        ArgumentNullException.ThrowIfNull(name);
        ArgumentNullException.ThrowIfNull(other);

        if (name.Length != other.Length)
        {
            return false;
        }

        for (var index = 0; index < name.Length; index += 1)
        {
            if (Folded(name[index]) != Folded(other[index]))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Refuses a declaration of <paramref name="procedure"/> with an <see cref="ArgumentException"/>
    /// naming <paramref name="parameter"/>, for the first reason of 16.10 that applies: out of its
    /// range, a service or a procedure not from 1 to 65535 or a revision below 1; then off its form,
    /// a name that is no procedure's. Its sentence holds the reason's words.
    /// </summary>
    public static void Check(Procedure procedure, string parameter)
    {
        ArgumentNullException.ThrowIfNull(procedure);

        // * a ushort holds no id past 65535, and an int no revision past 2³¹ − 1: what remains is 0
        // and below
        if (procedure.ServiceId == 0 || procedure.ProcedureId == 0 || procedure.ServiceRevision < 1)
        {
            throw new ArgumentException(
                string.Create(
                    CultureInfo.InvariantCulture,
                    $"\"{procedure.ProcedureName}\" at {procedure.ServiceId}/{procedure.ProcedureId}, revision {procedure.ServiceRevision}, is out of its range: a service and a procedure are from 1 to 65535, a revision from 1 to 2147483647 (spec 16.2)"),
                parameter);
        }

        if (!IsProcedureName(procedure.ProcedureName))
        {
            throw new ArgumentException(
                string.Create(
                    CultureInfo.InvariantCulture,
                    $"\"{procedure.ProcedureName}\" at {procedure.ServiceId}/{procedure.ProcedureId} is off its form: a procedure's name is a lower-case ASCII letter, then up to 62 ASCII letters or digits (spec 16.4)"),
                parameter);
        }
    }

    /// <summary>
    /// Refuses a declaration of <paramref name="procedure"/> the way <paramref name="declaration"/>
    /// names, as <see cref="Check(Procedure, string)"/> does, then for the third reason of 16.10:
    /// against its kind, a kind the way does not take (16.11). A procedure that states no kind is
    /// taken every way.
    /// </summary>
    public static void Check(Procedure procedure, (DeclarationWay Way, string Parameter) declaration)
    {
        Check(procedure, declaration.Parameter);

        if (procedure.ProcedureKind is not { } procedureKind)
        {
            return;
        }

        var (way, takes) = WayOf(declaration.Way);

        if (!takes.Contains(procedureKind))
        {
            throw new ArgumentException(
                string.Create(
                    CultureInfo.InvariantCulture,
                    $"\"{procedure.ProcedureName}\" at {procedure.ServiceId}/{procedure.ProcedureId} is against its kind: {WordsOf(procedureKind)}, which {way} does not take; it takes {string.Join(", or ", takes.Select(WordsOf))} (spec 16.11)"),
                declaration.Parameter);
        }
    }
}
