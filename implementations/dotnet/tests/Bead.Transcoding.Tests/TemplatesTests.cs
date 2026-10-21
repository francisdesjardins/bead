namespace Bead.Transcoding.Tests;

/// <summary>
/// <see cref="HttpTemplate"/>: <c>http.proto</c>'s templates parsed, a raw path matched and split,
/// each variable decoded, and the precedence one route of a method answers by (transcoding 3.5 to
/// 3.9). The twins of the TypeScript side's <c>templates.test.ts</c>.
/// </summary>
public sealed class TemplatesTests
{
    private static HttpPath PathOf(string path)
    {
        return HttpPath.Of(path) ?? throw new InvalidOperationException($"{path} matches nothing");
    }

    [Fact]
    public void Parses_a_template_as_http_proto_s_grammar_states_it_and_refuses_any_other()
    {
        var template = HttpTemplate.Parse("/v1/{book.name=shelves/*/books/**}:archive");

        Assert.Equal(
            [
                new HttpSegment(HttpSegmentKind.Literal, "v1"),
                new HttpSegment(HttpSegmentKind.Literal, "shelves"),
                new HttpSegment(HttpSegmentKind.Star, null),
                new HttpSegment(HttpSegmentKind.Literal, "books"),
                new HttpSegment(HttpSegmentKind.Stars, null),
            ],
            template.Segments);
        Assert.Equal([new HttpVariable("book.name", 1, 5)], template.Variables);
        Assert.Equal("archive", template.Verb);

        // a variable of no pattern is one segment's
        Assert.Equal([new HttpSegment(HttpSegmentKind.Literal, "books"), new HttpSegment(HttpSegmentKind.Star, null)], HttpTemplate.Parse("/books/{name}").Segments);

        foreach (var (text, reason) in new[]
        {
            ("v1/books", "a template that does not begin with /"),
            ("/v1/**/books", "a ** that is not its last segment"),
            ("/v1/{a={b}}", "a variable within a variable"),
            ("/v1/{name=*", "a variable that does not close"),
            ("/v1/bo%6Fks", "a literal that is no segment"),
            ("/v1//books", "a literal that is no segment"),
            ("/v1/books:", "a verb that is no literal"),
        })
        {
            Assert.Equal(reason, Assert.Throws<FormatException>(() =>
            {
                HttpTemplate.Parse(text);
            }).Message);
        }
    }

    [Fact]
    public void Matches_a_raw_path_a_single_segment_decoded_whole_and_a_multi_segment_one_but_its_2F()
    {
        var single = HttpTemplate.Parse("/v1/books/{name}");
        var multi = HttpTemplate.Parse("/v1/{name=shelves/*/books/*}");

        Assert.Equal("a/b", single.ValuesOf(PathOf("/v1/books/a%2Fb"))["name"]);
        Assert.Equal("a:b", single.ValuesOf(PathOf("/v1/books/a%3Ab"))["name"]);
        Assert.Equal("a+b", single.ValuesOf(PathOf("/v1/books/a+b"))["name"]);
        Assert.Equal("shelves/a%2Fb/books/c", multi.ValuesOf(PathOf("/v1/shelves/a%2Fb/books/c"))["name"]);
        Assert.Equal("shelves/ /books/x", multi.ValuesOf(PathOf("/v1/shelves/%20/books/x"))["name"]);

        // * matched raw: a path is case-sensitive, and an encoded slash is no segment's end
        Assert.False(HttpTemplate.Parse("/api/Transcoding/echo").Matches(PathOf("/api/transcoding/echo")));
        Assert.True(single.Matches(PathOf("/v1/books/a%2Fb")));

        foreach (var refused in new[] { "/v1/books/%ZZ", "/v1/books/%4", "/v1/books/%FF", "/v1/books/%C3%28" })
        {
            Assert.Throws<FormatException>(() =>
            {
                single.ValuesOf(PathOf(refused));
            });
        }
    }

    [Fact]
    public void Matches_no_path_with_an_empty_or_a_dot_segment()
    {
        foreach (var path in new[] { "/v1/books/..", "/v1/books/.", "/v1/books/%2E%2E", "/v1/books/%2e", "/v1/books/", "/v1//books/a", "/v1/books/a/..", "v1/books" })
        {
            Assert.Null(HttpPath.Of(path));
        }

        // a segment that holds dots beside its other characters is a segment as any other
        Assert.NotNull(HttpPath.Of("/v1/books/a..b"));
    }

    [Fact]
    public void Answers_by_a_literal_before_a_star_a_star_before_a_double_star_and_a_route_that_ends_before_a_double_star_of_none()
    {
        var literal = new[] { HttpTemplate.Parse("/v1/books/{name}"), HttpTemplate.Parse("/v1/books/special") };
        var star = new[] { HttpTemplate.Parse("/v1/{name=things/**}"), HttpTemplate.Parse("/v1/things/{id}") };
        var operations = new[] { HttpTemplate.Parse("/v1/{name=operations}"), HttpTemplate.Parse("/v1/{name=operations/**}") };

        Assert.Equal(1, HttpTemplate.Answering(literal, PathOf("/v1/books/special")));
        Assert.Equal(0, HttpTemplate.Answering(literal, PathOf("/v1/books/other")));
        Assert.Equal(1, HttpTemplate.Answering(star, PathOf("/v1/things/a")));
        Assert.Equal(0, HttpTemplate.Answering(star, PathOf("/v1/things/a/b")));

        // * google.longrunning's two templates: the one that ends where the path ends first
        Assert.Equal(0, HttpTemplate.Answering(operations, PathOf("/v1/operations")));
        Assert.Equal(1, HttpTemplate.Answering(operations, PathOf("/v1/operations/abc")));
        Assert.Null(HttpTemplate.Answering(operations, PathOf("/v2/operations")));

        // two of one shape tie, whatever their variables' names; a star and a double star do not
        Assert.True(HttpTemplate.Parse("/v1/books/{name}").Ties(HttpTemplate.Parse("/v1/books/{id}")));
        Assert.False(HttpTemplate.Parse("/v1/{name=*}").Ties(HttpTemplate.Parse("/v1/{name=**}")));
    }

    [Fact]
    public void Splits_the_verb_at_the_last_colon_its_last_segment_holds_unencoded()
    {
        var templates = new[] { HttpTemplate.Parse("/v1/{name=shelves/*/books/*}:archive"), HttpTemplate.Parse("/v1/{name=shelves/*/books/*}") };
        var path = PathOf("/v1/shelves/1/books/a:b:archive");

        Assert.Equal("archive", path.Verb);
        Assert.Equal(0, HttpTemplate.Answering(templates, path));
        Assert.Equal("shelves/1/books/a:b", templates[0].ValuesOf(path)["name"]);
        Assert.Equal(1, HttpTemplate.Answering(templates, PathOf("/v1/shelves/1/books/2")));
        Assert.Null(HttpTemplate.Answering(templates, PathOf("/v1/shelves/1/books/2:frobnicate")));
        Assert.Null(PathOf("/v1/books/a%3Ab").Verb);
    }
}
