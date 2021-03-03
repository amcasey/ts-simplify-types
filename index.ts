import fs = require("fs");
import perf_hooks = require("perf_hooks");
import stream = require("stream");
import util = require("util");
import zlib = require("zlib");

import split = require("split2");
import yargs = require("yargs");

// @ts-ignore - no types
import jsonstream = require("jsonstream-next");

const pipeline: (...stream: any[]) => Promise<void> = util.promisify(stream.pipeline);

const args = yargs(process.argv.slice(2))
    .command("$0 <input> <output>", "Preprocess tracing type dumps", yargs => yargs
        .positional("input", { type: "string", desc: "json file to read (possibly compressed)" })
        .positional("output", { type: "string", desc: "json file to write (possibly compressed)" })
        .options({
            "m": {
                alias: "multiline",
                describe: "use true json parsing, rather than assuming each element is on a separate line",
                type: "boolean"
            }
        })
        .help("h").alias("h", "help")
        .strict())
    .argv;

async function processFile(processElement: (element: {}) => readonly {}[]) {
    const stages: any[] = [];

    const inputPath = args.input!;

    stages.push(fs.createReadStream(inputPath));

    if (inputPath.endsWith(".gz")) {
        stages.push(zlib.createGunzip());
    }
    else if (inputPath.endsWith(".br")) {
        stages.push(zlib.createBrotliDecompress());
    }

    if (args.m) {
        const transform = jsonstream.parse("*");

        const oldFlush: (cb: (err?: Error) => void) => void = transform._flush.bind(transform);
        const newFlush: typeof oldFlush = cb => {
            return oldFlush(err => {
                if (err) {
                    // Incomplete JSON is normal (e.g. crash during tracing), so we swallow errors
                    // and finish writing the output.
                    console.log("Parse error: " + err.message);
                }
                cb();
            });
        };
        transform._flush = newFlush;

        stages.push(transform);
    }
    else {
        stages.push(split(/,?\r?\n/));

        let sawError = false;
        stages.push(new stream.Transform({
            objectMode: true,
            transform(chunk, _encoding, callback) {
                if (!sawError) {
                    try {
                        const obj = JSON.parse(chunk.replace(/^\[/, "").replace(/\]$/, ""));
                        callback(undefined, obj);
                        return;
                    }
                    catch (e) {
                        if (!(e instanceof SyntaxError)) {
                            throw e;
                        }

                        // Incomplete JSON is normal (e.g. crash during tracing), so we swallow errors
                        // and finish writing the output.
                        sawError = true;
                        console.log("Parse error: " + e.message);
                        console.log("\tConsider re-running with '-m'");
                    }
                }

                console.log("\tDropping " + chunk);
                callback();
            },
        }));
    }

    stages.push(new stream.Transform({
        objectMode: true,
        transform(obj, _encoding, callback) {
            const results = processElement(obj);
            if (results && results.length) {
                for (const result of results) {
                    this.push(result);
                }
            }
            callback();
        }
    }));

    let first = true;
    stages.push(new stream.Transform({
        objectMode: true,
        transform(chunk, _encoding, callback) {
            if (first) {
                first = false;
                this.push("[");
            }
            else {
                this.push(",\n");
            }

            this.push(JSON.stringify(chunk));

            callback();
        },
        flush(callback) {
            callback(undefined, "]");
        }
    }));

    const outputPath = args.output!;
    if (outputPath.endsWith(".gz")) {
        stages.push(zlib.createGzip());
    }
    else if (outputPath.endsWith(".br")) {
        stages.push(zlib.createBrotliCompress());
    }

    stages.push(fs.createWriteStream(outputPath));

    await pipeline(stages);
}

function processType(type: any): readonly {}[] {
    const processed = processTypeHelper(type);

    // Normalize the property order

    const result: any = {
        id: processed.id,
        kind: processed.kind,
        name: processed.name,
        aliasTypeArguments: processed.aliasTypeArguments,
        instantiatedType: processed.instantiatedType,
        typeArguments: processed.typeArguments,
    };

    for (const prop in processed) {
        if (!result[prop] && prop !== "location" && prop !== "display") {
            result[prop] = processed[prop];
        }
    }

    result["location"] = processed.location;
    result["display"] = processed.display;

    return [result];
}

function processTypeHelper(type: any): any {
    type.name = type.symbolName;
    type.symbolName = undefined;

    const isDestructuring = !!type.destructuringPattern;
    const node = type.destructuringPattern ?? type.referenceLocation ?? type.firstDeclaration;
    type.destructuringPattern = undefined;
    type.referenceLocation = undefined;
    type.firstDeclaration = undefined;
    type.location = node && {
        path: node.path,
        line: node.start?.line,
        char: node.start?.character,
    };

    const flags = type.flags;
    type.flags = undefined;

    const display = type.display;
    type.display = undefined;

    type.recursionId = undefined;

    if (type.intrinsicName) {
        return {
            kind: "Intrinsic",
            ...type,
            name: type.intrinsicName,
            intrinsicName: undefined,
        };
    }

    if (type.unionTypes) {
        return {
            kind: makeAliasedKindIfNamed(type, "Union"),
            count: type.unionTypes.length,
            types: type.unionTypes,
            ...type,
            unionTypes: undefined,
        };
    }

    if (type.intersectionTypes) {
        return {
            kind: makeAliasedKindIfNamed(type, "Intersection"),
            count: type.intersectionTypes.length,
            types: type.intersectionTypes,
            ...type,
            intersectionTypes: undefined,
        };
    }

    if (type.indexedAccessObjectType) {
        return {
            kind: makeAliasedKindIfNamed(type, "IndexedAccess"),
            ...type,
        };
    }

    if (type.keyofType) {
        return {
            kind: makeAliasedKindIfNamed(type, "IndexType"),
            ...type,
        };
    }

    if (type.isTuple) {
        return {
            kind: makeAliasedKindIfNamed(type, "Tuple"),
            ...type,
            isTuple: undefined,
        };
    }

    if (type.conditionalCheckType) {
        return {
            kind: makeAliasedKindIfNamed(type, "ConditionalType"),
            ...type,
            conditionalTrueType: type.conditionalTrueType < 0 ? undefined : type.conditionalTrueType,
            conditionalFalseType: type.conditionalFalseType < 0 ? undefined : type.conditionalFalseType,
        };
    }

    if (type.substitutionBaseType) {
        return {
            kind: makeAliasedKindIfNamed(type, "SubstitutionType"),
            originalType: type.substitutionBaseType,
            ...type,
            substitutionBaseType: undefined,
        };
    }

    if (type.reverseMappedSourceType) {
        return {
            kind: makeAliasedKindIfNamed(type, "ReverseMappedType"),
            sourceType: type.reverseMappedSourceType,
            mappedType: type.reverseMappedMappedType,
            constraintType: type.reverseMappedConstraintType,
            ...type,
            reverseMappedSourceType: undefined,
            reverseMappedMappedType: undefined,
            reverseMappedConstraintType: undefined,
        };
    }

    if (type.aliasTypeArguments) {
        return {
            kind: "GenericTypeAlias",
            ...type,
            instantiatedType: undefined,
            aliasedType: type.instantiatedType,
            aliasedTypeTypeArguments: type.typeArguments,
        };
    }

    if (type.instantiatedType && type.typeArguments?.length) {
        const instantiatedIsSelf = type.instantiatedType === type.id;
        return {
            kind: instantiatedIsSelf ? "GenericType" : "GenericInstantiation",
            ...type,
            instantiatedType: instantiatedIsSelf ? undefined : type.instantiatedType,
        };
    }

    if (isDestructuring) {
        return {
            kind: "Destructuring",
            ...type,
        };
    }

    if (flags.includes("StringLiteral")) {
        return {
            kind: "StringLiteral",
            value: display,
            ...type,
        };
    }

    if (flags.includes("NumberLiteral")) {
        return {
            kind: "NumberLiteral",
            value: display,
            ...type,
        };
    }

    if (flags.includes("BigIntLiteral")) {
        return {
            kind: "BigIntLiteral",
            value: display,
            ...type,
        };
    }

    if (flags.includes("TypeParameter")) {
        return {
            kind: "TypeParameter",
            ...type,
        };
    }

    if (flags.includes("UniqueESSymbol")) {
        return {
            kind: "Unique",
            ...type,
        };
    }

    if (type.name === "__type") {
        return {
            kind: "AnonymousType",
            ...type,
            display: type.location ? undefined : display,
            name: undefined,
        };
    }

    if (type.name === "__object") {
        return {
            kind: "AnonymousObject",
            ...type,
            display: type.location ? undefined : display,
            name: undefined,
        };
    }

    // This is less specific than the name checks
    if (flags.includes("Object")) {
        if (type.name) {
            return {
                kind: "Object",
                ...type,
            };
        }
    }

    // This goes at the end because it's a guess and depends on other interpretations having been checked previously
    if (display && display.startsWith("(props:") && display.endsWith("=> Element")) {
        return {
            kind: "JsxElementSignature",
            ...type,
            display
        };
    }

    return {
        kind: "Other",
        ...type,
        display
    };

    function makeAliasedKindIfNamed(type: { name?: string }, kind: string) {
        return type.name ? "Aliased" + kind : kind;
    }
}

async function run() {
    const start = perf_hooks.performance.now();
    let itemCount = 0;
    console.log("Processing...");
    try {
        await processFile(item => (itemCount++, processType(item)));
        console.log("Done");
    }
    catch (e) {
        console.log(`Error: ${e.message}`);
    }
    console.log(`Processed ${itemCount} items in ${Math.round(perf_hooks.performance.now() - start)} ms`);
}

run().catch(console.error);