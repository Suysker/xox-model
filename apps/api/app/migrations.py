from __future__ import annotations

from copy import deepcopy

from sqlalchemy import select

from .core import build_session_factory, get_settings
from .models import (
    ActualEntryAllocation,
    Base,
    ForecastLineItemFact,
    Workspace,
    WorkspaceDraft,
    WorkspaceVersion,
)

NAME_TRANSLATIONS = {
    "Default Workspace": "默认工作区",
    "Shareholder A": "股东 A",
    "Shareholder B": "股东 B",
    "Lead": "主成员",
    "Member A": "成员 A",
    "Member B": "成员 B",
    "Member C": "成员 C",
    "Member D": "成员 D",
    "Member E": "成员 E",
    "Member F": "成员 F",
    "Staff A": "员工 A",
    "Staff B": "员工 B",
    "Operations": "场务",
    "VJ": "舞台视觉",
    "VJ/月": "舞台视觉",
    "Original Song": "原创",
    "Makeup": "化妆",
    "Streaming": "推流",
    "Meal": "聚餐",
    "Team Building": "团建",
    "Material": "耗材",
}

SUBJECT_NAME_BY_KEY = {
    "revenue.offline_sales": "线下营收",
    "revenue.online_sales": "线上营收",
    "cost.member.commission": "成员提成",
    "cost.member.base_pay": "成员底薪",
    "cost.member.travel": "成员路费",
    "cost.employee.base_pay": "员工月薪",
    "cost.employee.per_event": "员工场次",
    "cost.training.rehearsal": "排练",
    "cost.training.teacher": "老师",
}

SCENARIO_COPY_BY_KEY = {
    "pessimistic": {
        "label": "悲观",
        "description": "按更保守的销量与排期预估，查看现金流下界。",
    },
    "base": {
        "label": "基准",
        "description": "按当前最可能发生的经营方案，作为主要判断口径。",
    },
    "optimistic": {
        "label": "乐观",
        "description": "按更好的销量与排期表现，查看经营上界。",
    },
}


def _translate_name(value: str | None) -> str | None:
    if value is None:
        return None
    return NAME_TRANSLATIONS.get(value, value)


def _localize_config_payload(payload: dict) -> tuple[dict, bool]:
    next_payload = deepcopy(payload)
    changed = False

    for collection_key in ("shareholders", "teamMembers", "employees", "stageCostItems"):
        for item in next_payload.get(collection_key, []):
            original_name = item.get("name")
            translated_name = _translate_name(original_name)
            if translated_name != original_name:
                item["name"] = translated_name
                changed = True

    for employee in next_payload.get("employees", []):
        original_role = employee.get("role")
        translated_role = _translate_name(original_role)
        if translated_role != original_role:
            employee["role"] = translated_role
            changed = True

    return next_payload, changed


def _localize_result_payload(payload: dict | None) -> tuple[dict | None, bool]:
    if payload is None:
        return None, False

    next_payload = deepcopy(payload)
    changed = False

    for scenario in next_payload.get("scenarios", []):
        scenario_key = scenario.get("key")
        scenario_copy = SCENARIO_COPY_BY_KEY.get(scenario_key)
        if scenario_copy is not None:
            if scenario.get("label") != scenario_copy["label"]:
                scenario["label"] = scenario_copy["label"]
                changed = True
            if scenario.get("description") != scenario_copy["description"]:
                scenario["description"] = scenario_copy["description"]
                changed = True

        for month in scenario.get("months", []):
            for member in month.get("members", []):
                original_name = member.get("name")
                translated_name = _translate_name(original_name)
                if translated_name != original_name:
                    member["name"] = translated_name
                    changed = True

            for employee in month.get("employees", []):
                original_name = employee.get("name")
                translated_name = _translate_name(original_name)
                if translated_name != original_name:
                    employee["name"] = translated_name
                    changed = True

                original_role = employee.get("role")
                translated_role = _translate_name(original_role)
                if translated_role != original_role:
                    employee["role"] = translated_role
                    changed = True

    return next_payload, changed


def run_migrations() -> None:
    settings = get_settings()
    db_factory = build_session_factory(settings)
    with db_factory() as session:
        Base.metadata.create_all(bind=session.get_bind())
        changed = False

        for workspace in session.scalars(select(Workspace)).all():
            translated_name = _translate_name(workspace.name)
            if translated_name != workspace.name:
                workspace.name = translated_name
                changed = True

        for draft in session.scalars(select(WorkspaceDraft)).all():
            next_config, draft_changed = _localize_config_payload(draft.config_json)
            if draft_changed:
                draft.config_json = next_config
                changed = True
            next_result, result_changed = _localize_result_payload(draft.result_json)
            if result_changed:
                draft.result_json = next_result
                changed = True

        for version in session.scalars(select(WorkspaceVersion)).all():
            next_payload, payload_changed = _localize_config_payload(version.payload_json)
            if payload_changed:
                version.payload_json = next_payload
                changed = True
            next_result, result_changed = _localize_result_payload(version.result_json)
            if result_changed:
                version.result_json = next_result
                changed = True

            if version.name.startswith("Snapshot "):
                version.name = version.name.replace("Snapshot ", "快照 ", 1)
                changed = True
            elif version.name.startswith("Release "):
                version.name = version.name.replace("Release ", "发布版 ", 1)
                changed = True

        for fact in session.scalars(select(ForecastLineItemFact)).all():
            translated_name = SUBJECT_NAME_BY_KEY.get(fact.subject_key, _translate_name(fact.subject_name))
            if translated_name != fact.subject_name:
                fact.subject_name = translated_name
                changed = True

        for allocation in session.scalars(select(ActualEntryAllocation)).all():
            translated_name = SUBJECT_NAME_BY_KEY.get(allocation.subject_key, _translate_name(allocation.subject_name))
            if translated_name != allocation.subject_name:
                allocation.subject_name = translated_name
                changed = True

        if changed:
            session.commit()


if __name__ == "__main__":
    run_migrations()
