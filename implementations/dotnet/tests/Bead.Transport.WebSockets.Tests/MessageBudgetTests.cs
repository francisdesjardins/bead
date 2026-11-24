namespace Bead.Transport.WebSockets.Tests;

/// <summary>
/// <see cref="MessageBudget"/> alone (spec 15.12, decision 0056): a charge of n decides as n
/// charges of one, and the unit that would pass it casts off the holder whose message holds the
/// most, then, among equal sums, the one whose message began first, the asking one only when it
/// comes first.
/// </summary>
public sealed class MessageBudgetTests
{
    // helpers

    // a holder of `budget` named `name`, its message begun, which tells `gone` once it is cast off
    private static MessageBudget.Holder HolderOf((MessageBudget Budget, string Name, List<string> Gone) given)
    {
        var (budget, name, gone) = given;
        var holder = new MessageBudget.Holder(() =>
        {
            gone.Add(name);
        });

        budget.Begin(holder);

        return holder;
    }

    // `charges` charged in turn to `holder`: false at the first not taken, the asking holder cast off
    private static bool ChargesOf((MessageBudget Budget, MessageBudget.Holder Holder) charging, IEnumerable<long> charges)
    {
        foreach (var charge in charges)
        {
            if (!charging.Budget.Charge((charging.Holder, charge)))
            {
                return false;
            }
        }

        return true;
    }

    // definition

    // spec 15.12; IANA's WebSocket Close Code Number Registry, 1013
    [Fact]
    public void Casts_off_with_1013_the_connections_whose_messages_hold_the_most_when_a_charge_would_pass_messageBytesBudget_its_own_only_when_it_comes_first()
    {
        var budget = new MessageBudget(500);
        var gone = new List<string>();
        var ada = HolderOf((budget, "ada", gone));
        var bob = HolderOf((budget, "bob", gone));

        Assert.True(budget.Charge((ada, 194)));
        Assert.True(budget.Charge((bob, 146)));
        Assert.Equal(340, budget.Charged);

        // carol's 174 passes it: ada, who holds the most, is cast off, carol's charge taken
        var carol = HolderOf((budget, "carol", gone));

        Assert.True(budget.Charge((carol, 174)));
        Assert.Equal(["ada"], gone);
        Assert.Equal(320, budget.Charged);

        // dave's 234 passes it: at its 181st byte, he holds more than any other, and he alone is cast
        // off, what he held released, his own cast-off his caller's
        var dave = HolderOf((budget, "dave", gone));

        Assert.False(budget.Charge((dave, 234)));
        Assert.Equal(["ada"], gone);
        Assert.Equal((320, 0), (budget.Charged, dave.Sum));

        // a charge of bob's that ties carol: the one whose message began first, bob, goes first
        Assert.True(budget.Charge((bob, 28)));
        Assert.Equal(348, budget.Charged);

        var eve = HolderOf((budget, "eve", gone));

        Assert.True(budget.Charge((eve, 160)));
        Assert.Equal(["ada", "bob"], gone);
        Assert.Equal(334, budget.Charged);

        // a sum past the budget alone casts off its own holder, none other
        Assert.False(budget.Charge((carol, 400)));
        Assert.Equal(["ada", "bob"], gone);
        Assert.Equal(160, budget.Charged);

        // a message whole, its charge released; a holder that leaves, its charge with it
        budget.Release(eve);
        Assert.Equal((0, 0), (eve.Sum, budget.Charged));
        budget.Begin(eve);
        Assert.True(budget.Charge((eve, 10)));
        budget.Leave(eve);
        Assert.Equal(0, budget.Charged);
    }

    // spec 15.12
    [Fact]
    public void Charges_byte_by_byte_casting_off_whom_the_unit_that_passes_the_budget_finds_first()
    {
        // * a's 700 at once, in two, or a unit at a time: the unit that passes 1,000 meets x's 600,
        // more than a's 401, so x is cast off, and a's 700 is taken whole
        foreach (var cuts in new long[][] { [700], [450, 250], [.. Enumerable.Repeat(1L, 700)] })
        {
            var budget = new MessageBudget(1_000);
            var gone = new List<string>();
            var x = HolderOf((budget, "x", gone));
            var a = HolderOf((budget, "a", gone));

            Assert.True(budget.Charge((x, 600)));
            Assert.True(ChargesOf((budget, a), cuts));
            Assert.Equal(["x"], gone);
            Assert.Equal(700, budget.Charged);
        }
    }

    // spec 15.12
    [Fact]
    public void Casts_off_each_holder_that_comes_before_a_message_whose_charge_alone_passes_the_budget_then_that_message_s_connection()
    {
        var budget = new MessageBudget(2_000);
        var gone = new List<string>();
        var p = HolderOf((budget, "p", gone));
        var a = HolderOf((budget, "a", gone));

        Assert.True(budget.Charge((p, 1_096)));

        // * a's 2,036: its unit at 905 meets p's 1,096, which is cast off; its unit at 2,001 meets no
        // one, and a is cast off itself, its charge released
        Assert.False(budget.Charge((a, 2_036)));
        Assert.Equal(["p"], gone);
        Assert.Equal(0, budget.Charged);

        // cast off, it charges nothing more
        Assert.False(budget.Charge((a, 1)));
        Assert.Equal(0, budget.Charged);
    }

    // spec 15.12
    [Fact]
    public void Casts_off_among_equal_sums_the_holder_whose_message_began_first()
    {
        var budget = new MessageBudget(1_000);
        var gone = new List<string>();
        var x = HolderOf((budget, "x", gone));
        var y = HolderOf((budget, "y", gone));
        var z = HolderOf((budget, "z", gone));

        // * y charged first, x begun first: x is cast off, not y
        Assert.True(budget.Charge((y, 400)));
        Assert.True(budget.Charge((x, 400)));
        Assert.True(budget.Charge((z, 300)));
        Assert.Equal(["x"], gone);
        Assert.Equal(700, budget.Charged);

        // * the asking one among equal sums: u, begun before v, comes first, its unit at 501 against
        // v's 501, and is cast off itself, v kept
        var even = new MessageBudget(1_001);
        var u = HolderOf((even, "u", gone));
        var v = HolderOf((even, "v", gone));

        Assert.True(even.Charge((v, 501)));
        Assert.False(even.Charge((u, 501)));
        Assert.Equal(["x"], gone);
        Assert.Equal(501, even.Charged);
    }
}
