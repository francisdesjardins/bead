using System.Collections.Frozen;
using System.Globalization;

namespace Bead;

/// <summary>
/// The procedures a server's transport takes (spec 9.11), checked as the transport is built (spec
/// 9.12): an address outside section 16.2's ranges or of service 0 is refused, as section 16.10
/// refuses a declaration, and an address named twice is one.
/// </summary>
internal static class ProceduresTaken
{
    /// <summary>
    /// The set of <paramref name="procedures"/>, none when none was given, every procedure then
    /// taken; an address of service 0 or of procedure 0, the only ones a <see cref="ushort"/> holds
    /// out of its range, is an <see cref="ArgumentException"/> naming its parameter, its sentence
    /// saying its transport.
    /// </summary>
    public static FrozenSet<ProcedureAddress>? Of(IReadOnlyCollection<ProcedureAddress>? procedures, (string Transport, string Parameter) named)
    {
        if (procedures is null)
        {
            return null;
        }

        foreach (var (serviceId, procedureId) in procedures)
        {
            if (serviceId == 0 || procedureId == 0)
            {
                throw new ArgumentException(
                    string.Create(
                        CultureInfo.InvariantCulture,
                        $"{named.Transport} takes {serviceId}/{procedureId}, out of its range: a service and a procedure are from 1 to 65535, service 0 the protocol's (spec 9.12, 16.2, 16.3)"),
                    named.Parameter);
            }
        }

        return procedures.ToFrozenSet();
    }

    /// <summary>
    /// Whether a connection takes <paramref name="address"/> by <paramref name="taken"/>: every
    /// procedure where none was given.
    /// </summary>
    public static bool Takes(FrozenSet<ProcedureAddress>? taken, ProcedureAddress address)
    {
        return taken is null || taken.Contains(address);
    }
}
