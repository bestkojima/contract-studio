"""Build Needs and export CodeLinks entities as a JSON runtime interface."""
import json
from pathlib import Path
import sys

from sphinx.application import Sphinx
from sphinx_codelinks.analyse.analyse import SourceAnalyse
from sphinx_codelinks.analyse.models import NeedIdRefs
from sphinx_codelinks.config import CodeLinksConfig, locate_src_dir
from sphinx_codelinks.sphinx_extension.need_id_refs import project_roots
from sphinx_codelinks.sphinx_extension.project_analysis import prepare_analyse_config
from sphinx_codelinks.sphinx_extension.rediscovery import effective_pages, effective_refs


def export_entities(app, root, config):
    """Reanalyse only this build's marked files with the installed CodeLinks API.

    Sphinx's reference records retain signature/rows but omit qualified names.
    SourceAnalyse supplies those names; no pickle or independent parser is used.
    """
    roots = project_roots(app.confdir, config)
    records = effective_refs(app.env, config)
    # Anchors exist only for native needs accepted by src-trace in this build.
    # Their source path is canonical even when a URL carries a Git-root prefix.
    declarations = {}
    for page in effective_pages(app.env, config):
        for line, _docname, need_id in page.anchors:
            declarations.setdefault((Path(page.source).resolve(), line), set()).add(need_id)
    entities = {}
    for project, project_config in sorted(config.projects.items()):
        source_dir = locate_src_dir(app.confdir, config, project_config["source_discover_config"])
        attached = {
            ((Path(roots[project]) / ref.path).resolve(), ref.lineno, ref.need_id)
            for ref in records if ref.project == project
        }
        files = {file for file, _, _ in attached}
        files.update(file for file, _ in declarations if file.is_relative_to(source_dir))
        if not files:
            continue
        analysis = SourceAnalyse(prepare_analyse_config(
            app.confdir, config, project_config, src_dir=source_dir,
            src_files=sorted(files),
        ), name=project)
        analysis.run(log_summary=False)
        for marker in analysis.all_marked_content:
            file = Path(marker.filepath).resolve()
            line = marker.source_map["start"]["row"] + 1
            native = not isinstance(marker, NeedIdRefs)
            need_ids = declarations.get((file, line), set()) if native else {
                need_id for need_id in marker.need_ids if (file, line, need_id) in attached
            }
            if not need_ids:
                continue
            relative = file.relative_to(root).as_posix()
            scope = marker.scope or {}
            tagged = marker.tagged_scope
            text = tagged.text.decode("utf-8") if tagged is not None and tagged.text else None
            start, end = scope.get("start"), scope.get("end")
            # Unattached markers remain explicit records with null scope fields.
            key = (relative, start, end, scope.get("qualified_name"), line if not scope else None)
            entity = entities.setdefault(key, {
                "path": relative,
                "symbol": scope.get("qualified_name"),
                "signature": text.splitlines()[0].strip() if text else None,
                "startLine": start,
                "endLine": end,
                "kind": scope.get("entity_kind"),
                "language": scope.get("language"),
                "needIds": set(),
                "markerLines": set(),
                "source": "sphinx-codelinks",
            })
            entity["needIds"].update(need_ids)
            entity["markerLines"].add(line)
            if native:
                for need_id in sorted(need_ids):
                    declaration = {
                        "needId": need_id, "line": line,
                        "endLine": marker.source_map["end"]["row"] + 1,
                        "kind": marker.type.value,
                    }
                    if declaration not in entity.setdefault("declarations", []):
                        entity["declarations"].append(declaration)
    result = list(entities.values())
    for entity in result:
        entity["needIds"] = sorted(entity["needIds"])
        entity["markerLines"] = sorted(entity["markerLines"])
    return sorted(result, key=lambda entity: (entity["path"], entity["markerLines"][0], entity["symbol"] or ""))


def main():
    source, output = (Path(value).resolve() for value in sys.argv[1:3])
    app = Sphinx(str(source), str(source), str(output), str(output / ".doctrees"),
                 "needs", freshenv=True, warningiserror=True)
    app.build(force_all=True)
    if app.statuscode:
        return app.statuscode
    config = CodeLinksConfig.from_sphinx(app.config)
    aliases = {}
    for name, project in config.projects.items():
        location = locate_src_dir(app.confdir, config, project["source_discover_config"])
        relative = location.relative_to(source.parent).as_posix()
        aliases[name] = relative
        aliases[location.name] = relative
    entities = export_entities(app, source.parent, config)
    if app.statuscode:
        return app.statuscode
    (output / "source-projects.json").write_text(json.dumps(aliases, indent=2), encoding="utf-8")
    (output / "code-entities.json").write_text(json.dumps({
        "schemaVersion": 1, "source": "sphinx-codelinks", "entities": entities,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
