using Bead.Codecs.V1;
using Bead.Transcoding.V1;
using Google.Protobuf;
using Needs = Bead.Transcoding.V1.Needs;
using ProbeNeeds = Bead.Codecs.V1.Needs;

namespace Bead.Protobuf.Tests;

/// <summary>
/// <see cref="ProtoRequired"/>'s walk of spec 17.9.7 over a message Google.Protobuf holds, on
/// <c>spec/transcoding.proto</c>'s <c>Requiring</c> and <c>spec/codecs.proto</c>'s <c>Probe</c>: its
/// order, and what it names. <see cref="ProtoCodecsTests"/> plays it through the reader and the
/// writer. The twin of the TypeScript side's <c>required.test.ts</c>, sentence for sentence.
/// </summary>
public sealed class ProtoRequiredTests
{
    // helpers

    // the path the walk gives of a message: each step's field by its name, then an item's index or
    // a map's key as it is, then the field left unset; none where it leaves none
    private static object[]? PathOf(IMessage message)
    {
        if (ProtoRequired.UnsetOf(message) is not { } unset)
        {
            return null;
        }

        var path = new List<object>();

        foreach (var step in unset.Steps)
        {
            path.Add(step.Field.Name);

            if (step.Index is { } index)
            {
                path.Add(index);
            }
            else if (step.Key is { } key)
            {
                path.Add(key);
            }
        }

        path.Add(unset.Field.Name);

        return [.. path];
    }

    // definition

    [Fact]
    public void Takes_a_message_s_own_fields_by_number_before_what_it_holds_and_what_it_holds_depth_first_by_field_number()
    {
        Assert.Equal(["needs", "name"], PathOf(new Requiring { Needs = new Needs() }));
        Assert.Equal(
            ["needs", "count"],
            PathOf(new Requiring { Needs = new Needs { Child = new Needs { Name = "b" }, Name = "a" } })
        );
        Assert.Equal(
            ["needs", "child", "count"],
            PathOf(new Requiring
            {
                Many = { new Needs { Name = "c" } },
                Needs = new Needs { Child = new Needs { Name = "b" }, Count = 1, Name = "a" },
            })
        );
        Assert.Equal(
            ["many", 1, "count"],
            PathOf(new Requiring { Many = { new Needs { Count = 1, Name = "a" }, new Needs { Name = "b" } } })
        );
        Assert.Null(PathOf(new Requiring { Needs = new Needs { Count = 0, Name = "" } }));
    }

    [Fact]
    public void Takes_a_map_s_values_by_key_in_18_5_s_order_whatever_order_the_map_holds_them_in()
    {
        Assert.Equal(
            ["by_key", "a", "count"],
            PathOf(new Requiring { ByKey = { ["b"] = new Needs { Name = "x" }, ["a"] = new Needs { Name = "y" } } })
        );
    }

    [Fact]
    public void Names_the_field_a_path_leaves_unset_by_its_full_name()
    {
        var probe = new Probe { NeedsItems = { new ProbeNeeds { Must = 1 } } };

        Assert.Equal(["needs_items", 0, "shade"], PathOf(probe));
        Assert.Equal("bead.codecs.v1.Needs.shade", ProtoRequired.UnsetOf(probe)?.Field.FullName);
    }
}
