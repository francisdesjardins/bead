using System.Reflection;
using System.Runtime.CompilerServices;
using Bead.Protobuf;
using Bead.Transcoding;
using Bead.Transcoding.Http;
using Bead.Transport.Amqp;
using Bead.Transport.Mqtt;
using Bead.Transport.WebSockets;

namespace Bead.Transport.Http.Tests;

/// <summary>
/// The options rule over this side's public surface, by reflection over the eight assemblies an
/// application calls (decisions 0004 and 0007): an options record is a sealed record of
/// <c>init</c> properties, at most two of them <c>required</c>, a setting it cannot be built
/// without; and a parameter that takes one is required exactly when one of its members is. What the
/// rule reads the compiler writes into the assembly: <c>RequiredMemberAttribute</c>, the
/// <c>IsExternalInit</c> modifier and a parameter's default. The TypeScript side's twin is
/// <c>tools/check-surface.mjs</c>; the members each side exposes are pinned apart, the C# side's in
/// each project's <c>PublicAPI.Shipped.txt</c> and <c>PublicAPI.Unshipped.txt</c>.
/// </summary>
public sealed class SurfaceTests
{
    // constants

    private const BindingFlags Declared = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;

    // ! read by name: a package beneath a transport defines its own of each, for the frameworks
    // before them, and only the platform's are the compiler's here
    private const string RequiredMember = "System.Runtime.CompilerServices.RequiredMemberAttribute";

    private const string ExternalInit = "System.Runtime.CompilerServices.IsExternalInit";

    // the eight assemblies an application calls, each by a type of its own
    private static readonly Assembly[] Assemblies =
    [
        typeof(RouterClient).Assembly,
        typeof(IViolationSink).Assembly,
        typeof(JsonForm).Assembly,
        typeof(HttpGateway).Assembly,
        typeof(HttpTransportClient).Assembly,
        typeof(WebSocketTransportClient).Assembly,
        typeof(MqttBrokerAdapter).Assembly,
        typeof(AmqpBrokerAdapter).Assembly,
    ];

    // helpers

    // every public type, of every assembly
    private static IEnumerable<Type> PublicTypes()
    {
        return Assemblies.SelectMany((assembly) =>
        {
            return assembly.GetExportedTypes();
        });
    }

    // whether a type's name, its arity aside, says it is an options record
    private static bool IsOptions(Type type)
    {
        return type.Name.Split('`')[0].EndsWith("Options", StringComparison.Ordinal);
    }

    // every public options record
    private static IEnumerable<Type> OptionsRecords()
    {
        return PublicTypes().Where(IsOptions);
    }

    // the members of an options record the compiler marks required
    private static IEnumerable<string> RequiredOf(Type type)
    {
        var record = type.IsGenericType ? type.GetGenericTypeDefinition() : type;

        return record.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where((property) =>
            {
                return property.GetCustomAttributesData().Any((attribute) =>
                {
                    return attribute.AttributeType.FullName == RequiredMember;
                });
            })
            .Select((property) =>
            {
                return property.Name;
            });
    }

    // what a method of the surface is to the rule: what a programmer writes a call to, never what
    // the compiler makes of a record or a property
    private static bool IsCalled(MethodBase method)
    {
        if (method.IsDefined(typeof(CompilerGeneratedAttribute)))
        {
            return false;
        }

        if (method.IsSpecialName && method is MethodInfo && !method.Name.StartsWith("op_", StringComparison.Ordinal))
        {
            return false;
        }

        // a record's equality, which compares two of it
        if (method.Name is nameof(Equals) or "op_Equality" or "op_Inequality")
        {
            return false;
        }

        // a record's copy constructor, which `with` calls
        return method is not ConstructorInfo || method.GetParameters() is not [{ } only] || only.ParameterType != method.DeclaringType;
    }

    // whether another method of the same name takes what this one takes, the options aside: the
    // optional form a platform rule asks as an overload, as CA1032 asks an exception's
    // constructors, or the one a member required in some instantiations alone asks
    private static bool HasOverloadWithout(MethodBase method, ParameterInfo options)
    {
        var rest = method.GetParameters()
            .Where((parameter) =>
            {
                return parameter.Position != options.Position;
            })
            .Select((parameter) =>
            {
                return parameter.ParameterType;
            })
            .ToArray();

        return method.DeclaringType!.GetMembers(Declared).OfType<MethodBase>().Any((other) =>
        {
            return other.Name == method.Name && other.GetParameters().Select((parameter) =>
            {
                return parameter.ParameterType;
            }).SequenceEqual(rest);
        });
    }

    // what is off the rule in one options parameter, or none
    private static string? Judged(MethodBase method, ParameterInfo parameter)
    {
        var type = Nullable.GetUnderlyingType(parameter.ParameterType) ?? parameter.ParameterType;
        var required = RequiredOf(type).Any();
        var name = $"{method.DeclaringType!.FullName}.{method.Name}({parameter.Name}: {type.Name})";

        if (required && parameter.HasDefaultValue)
        {
            return $"{name}: optional though a member is required";
        }

        // * options Bead hands a callback are always given
        if (required || parameter.HasDefaultValue || typeof(Delegate).IsAssignableFrom(method.DeclaringType) || HasOverloadWithout(method, parameter))
        {
            return null;
        }

        return $"{name}: required though every member is optional";
    }

    // tests

    [Fact]
    public void Every_public_options_record_is_a_sealed_record_of_init_properties()
    {
        var records = OptionsRecords().ToList();
        var off = records
            .Where((type) =>
            {
                var isRecord = type.GetMethod("<Clone>$") is not null;
                var isInit = type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                    .Where((property) =>
                    {
                        return property.SetMethod is { IsPublic: true };
                    })
                    .All((property) =>
                    {
                        return property.SetMethod!.ReturnParameter.GetRequiredCustomModifiers().Any((modifier) =>
                        {
                            return modifier.FullName == ExternalInit;
                        });
                    });

                return !(type.IsSealed && isRecord && isInit);
            })
            .Select((type) =>
            {
                return type.FullName;
            });

        Assert.NotEmpty(records);
        Assert.Empty(off);
    }

    [Fact]
    public void Takes_an_options_record_required_exactly_when_one_of_its_members_is_required()
    {
        var judged = PublicTypes()
            .SelectMany((type) =>
            {
                return type.GetMembers(Declared).OfType<MethodBase>();
            })
            .Where(IsCalled)
            .SelectMany((method) =>
            {
                return method.GetParameters()
                    .Where((parameter) =>
                    {
                        return IsOptions(Nullable.GetUnderlyingType(parameter.ParameterType) ?? parameter.ParameterType);
                    })
                    .Select((parameter) =>
                    {
                        return Judged(method, parameter);
                    });
            })
            .ToList();

        Assert.NotEmpty(judged);
        Assert.Empty(judged.OfType<string>());
    }

    [Fact]
    public void An_options_record_requires_two_members_at_most()
    {
        var records = OptionsRecords().ToList();
        var off = records
            .Where((type) =>
            {
                return RequiredOf(type).Count() > 2;
            })
            .Select((type) =>
            {
                return $"{type.FullName}: {string.Join(", ", RequiredOf(type))}";
            });

        Assert.Contains(records, (type) =>
        {
            return RequiredOf(type).Any();
        });
        Assert.Empty(off);
    }
}
