using Bead.Codecs.V1;
using Bead.Protobuf.Tests.Codec;
using Bead.Transcoding.V1;
using Google.Protobuf.WellKnownTypes;
using ProbeNeeds = Bead.Codecs.V1.Needs;

namespace Bead.Protobuf.Tests;

/// <summary>
/// <see cref="ProtoDepth"/>: a <c>proto</c> writer's depth pass (spec 17.2, 17.9.3), skipped where a
/// message's known fields cannot nest past the bound. The twin of the TypeScript side's
/// <c>depth.test.ts</c> and the Rust side's <c>required/tests.rs</c>, sentence for sentence.
/// </summary>
public sealed class ProtoDepthTests
{
    [Fact]
    public void Walks_nothing_of_a_message_whose_fields_cannot_nest_past_the_bound()
    {
        // * Needs of spec/codecs.proto holds no message
        Assert.False(ProtoRecords.ShapeOf(ProbeNeeds.Descriptor).NestsPast);

        // a cycle nests past: through a child, a map's value, a Struct's Value
        foreach (var descriptor in new[] { Probe.Descriptor, Alone.Descriptor, Edges.Descriptor, Loop.Descriptor, Value.Descriptor })
        {
            Assert.True(ProtoRecords.ShapeOf(descriptor).NestsPast, descriptor.FullName);
        }

        // an Alone 101 deep, judged by Needs's shape, which nests past nothing: not walked at all
        var alone = new Alone();

        for (var index = 0; index < 101; index += 1)
        {
            alone = new Alone { Alone_ = alone };
        }

        ProtoDepth.Check(alone, ProtoRecords.ShapeOf(ProbeNeeds.Descriptor));

        // walked by its own
        var refused = Assert.Throws<FormatException>(() =>
        {
            ProtoDepth.Check(alone);
        });

        Assert.Equal("nested past 100", refused.Message);
    }
}
