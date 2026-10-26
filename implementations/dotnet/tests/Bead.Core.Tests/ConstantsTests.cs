namespace Bead.Tests;

/// <summary>
/// <see cref="ProtocolCode"/>: spec 8.1's table, each code in its stage's block of sixteen; and the
/// wire values of the envelope. The twins of the TypeScript side's <c>constants.test.ts</c>
/// (<c>ProtocolCode</c>, <c>the wire values</c>); an enum is fixed by its type, where the TypeScript
/// side's frozen object is held so by its test.
/// </summary>
public sealed class ConstantsTests
{
    // spec 8.1
    [Fact]
    public void Puts_each_code_in_the_block_of_the_stage_that_raises_it()
    {
        var blocks = new (ProtocolCode Code, int Block)[]
        {
            (ProtocolCode.EnvelopeMalformed, 0),
            (ProtocolCode.LayoutUnsupported, 0),
            (ProtocolCode.KindUnsupported, 0),
            (ProtocolCode.EnvelopeTooLarge, 0),
            (ProtocolCode.DestinationUnknown, 1),
            (ProtocolCode.DestinationUnreachable, 1),
            (ProtocolCode.ServiceUnknown, 1),
            (ProtocolCode.ProcedureUnknown, 1),
            (ProtocolCode.CallUnknown, 1),
            (ProtocolCode.SubscriptionUnknown, 1),
            (ProtocolCode.SubscriptionUnsupported, 1),
            (ProtocolCode.SessionRequired, 2),
            (ProtocolCode.AccessDenied, 2),
            (ProtocolCode.PayloadTooLarge, 2),
            (ProtocolCode.CapacityExceeded, 2),
            (ProtocolCode.CredentialUnsupported, 2),
            (ProtocolCode.ChunkInvalid, 3),
            (ProtocolCode.CreditExceeded, 3),
            (ProtocolCode.PayloadUndecodable, 3),
            (ProtocolCode.TransferStalled, 3),
            (ProtocolCode.PayloadInvalid, 3),
            (ProtocolCode.ProcedureFailed, 4),
            (ProtocolCode.DestinationLost, 4),
        };

        Assert.Equal(Enum.GetValues<ProtocolCode>(), blocks.Select((each) =>
        {
            return each.Code;
        }));

        foreach (var (code, block) in blocks)
        {
            Assert.Equal(block, (ushort)code / 16);
        }
    }

    [Fact]
    public void Holds_23_codes_each_once_and_leaves_out_the_ones_to_come()
    {
        var codes = Enum.GetValues<ProtocolCode>().Select((code) =>
        {
            return (int)code;
        }).ToArray();

        Assert.Equal(23, codes.Length);
        Assert.Equal(23, codes.Distinct().Count());

        foreach (var later in new[] { 23, 37, 53, 66 })
        {
            Assert.DoesNotContain(later, codes);
        }
    }

    [Fact]
    public void Are_the_layout_the_kinds_the_flags_and_the_scopes_of_the_envelope()
    {
        Assert.Equal(new byte[] { 0xA1 }, Enum.GetValues<EnvelopeLayout>().Select((layout) =>
        {
            return (byte)layout;
        }));
        Assert.Equal(
            new (EnvelopeKind, byte)[]
            {
                (EnvelopeKind.Request, 0x10),
                (EnvelopeKind.Result, 0x11),
                (EnvelopeKind.Failure, 0x12),
                (EnvelopeKind.Notification, 0x13),
                (EnvelopeKind.Chunk, 0x14),
                (EnvelopeKind.Credit, 0x15),
                (EnvelopeKind.Cancel, 0x16),
            },
            Enum.GetValues<EnvelopeKind>().Select((kind) =>
            {
                return (kind, (byte)kind);
            }));
        Assert.Equal(
            new (EnvelopeFlags, byte)[]
            {
                (EnvelopeFlags.None, 0x00),
                (EnvelopeFlags.Destination, 0x02),
                (EnvelopeFlags.Transfer, 0x04),
                (EnvelopeFlags.Credential, 0x08),
                (EnvelopeFlags.Subscription, 0x10),
                (EnvelopeFlags.Paced, 0x20),
                (EnvelopeFlags.More, 0x40),
            },
            Enum.GetValues<EnvelopeFlags>().Select((flag) =>
            {
                return (flag, (byte)flag);
            }));
        Assert.Equal(
            new (CredentialScheme, ushort)[]
            {
                (CredentialScheme.None, 0),
                (CredentialScheme.Opaque, 1),
                (CredentialScheme.Jwt, 2),
                (CredentialScheme.Elsewhere, 3),
            },
            Enum.GetValues<CredentialScheme>().Select((scheme) =>
            {
                return (scheme, (ushort)scheme);
            }));
        Assert.Equal(
            new (FailureScope, byte)[] { (FailureScope.Protocol, 0), (FailureScope.Application, 1) },
            Enum.GetValues<FailureScope>().Select((scope) =>
            {
                return (scope, (byte)scope);
            }));
        Assert.Equal(16, SessionToken.Bytes);
    }
}
