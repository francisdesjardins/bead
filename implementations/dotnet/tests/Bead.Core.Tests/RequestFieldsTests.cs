namespace Bead.Tests;

/// <summary>
/// <see cref="RequestFields"/>: what HTTP refuses of a request's fields before anything else of it
/// is judged (spec 15.12), by the rows the TypeScript side judges alike.
/// </summary>
public sealed class RequestFieldsTests
{
    // spec 15.12; RFC 9110 §8.6
    [Fact]
    public void IsCountedLength_takes_digits_alone_whose_number_is_2_63_1_at_most_leading_zeros_read_by_value_and_refuses_any_other()
    {
        // 0, 0 forty times, 1 led by 39 zeros, 2⁶³ − 1 in 19 digits and in 23
        string[] counted = ["0", new string('0', 40), $"{new string('0', 39)}1", "9223372036854775807", "00009223372036854775807"];

        // 2⁶³ in 19 digits and in 23, 19 nines, 2⁶⁴, 23 nines; none, empty, a sign, a word, a space
        string?[] refused =
        [
            "9223372036854775808",
            "00009223372036854775808",
            new string('9', 19),
            "18446744073709551616",
            new string('9', 23),
            null,
            "",
            "+1",
            "-0",
            "abc",
            "1 2",
        ];

        Assert.All(counted, (value) =>
        {
            Assert.True(RequestFields.IsCountedLength(value), value);
        });
        Assert.All(refused, (value) =>
        {
            Assert.False(RequestFields.IsCountedLength(value), value);
        });
    }
}
