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

    // spec 15.12; RFC 9112 §6.1, §6.3; RFC 9110 §5.6.1.2
    [Fact]
    public void IsTransferEncodingFramed_takes_chunked_as_its_one_coding_in_any_case_over_HTTP_1_1_an_empty_element_before_it_ignored_and_refuses_a_coding_before_it_anything_after_it_and_one_an_HTTP_1_0_request_carries()
    {
        // none at all, over either version
        Assert.True(RequestFields.IsTransferEncodingFramed("HTTP/1.1", []));
        Assert.True(RequestFields.IsTransferEncodingFramed("HTTP/1.0", []));

        // chunked as the one coding, in any case, an empty element before it in one line or two
        string[][] taken = [["chunked"], ["Chunked"], [", chunked"], [",  , chunked"], ["", "chunked"]];

        // a coding before chunked, in one line or two; a final coding other than chunked; anything
        // after the first chunked; and chunked with a parameter
        string[][] refused =
        [
            ["gzip, chunked"],
            ["x-unknown, chunked"],
            ["identity, chunked"],
            ["gzip, , chunked"],
            ["gzip", "chunked"],
            ["gzip"],
            ["chunked, gzip"],
            ["chunked,"],
            ["chunked, chunked"],
            ["chunked;q=1"],
        ];

        Assert.All(taken, (lines) =>
        {
            Assert.True(RequestFields.IsTransferEncodingFramed("HTTP/1.1", lines), string.Join(" | ", lines));
        });
        Assert.All(refused, (lines) =>
        {
            Assert.False(RequestFields.IsTransferEncodingFramed("HTTP/1.1", lines), string.Join(" | ", lines));
        });

        // chunked alone, over HTTP/1.0
        Assert.False(RequestFields.IsTransferEncodingFramed("HTTP/1.0", ["chunked"]));
    }
}
