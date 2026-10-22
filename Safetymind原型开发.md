# Safetymind原型开发工作区

## Harness Todo list:（这是我们要做的）

* [X]  开发所需工具包 SDK
* [X]  设计 span 格式
* [ ]  【a】商定所需 type 和字段
* [ ]  用开源智能体植入 span
* [ ]  【c】连接 Monitor 后端
* [ ]  【d】收集和提供 trace 数据
* [ ]  建立防护机制（护栏设计）
* [ ]  【f】根据两侧检测机制，建立检测数据并完成端到端评测前半
* [ ]  评测验证

## Monitor Todo list:

* [X]  搭建平台雏形，建立 trace 查看与管理
* [ ]  【a】商定所需 type 和字段
* [ ]  【b】开放接收端口
* [ ]  【e】接收数据做格式验证
* [ ]  建立监控机制（宏观监控和聚合、异常收集和告警）
* [ ]  【f】完成端到端评测后半
* [ ]  评测验证

## 任务进度：【a】span 设计协议（待商议）

### 1、Span名称规范

\<domain\>\.\<action\>

举例：

tracer\.start\_span\("model\_call", attributes=\{

"model\.name": "豆包xxx",

"model\.provider": "豆包",

\}\)

### 2、Attributes命名规范

- 格式：`<domain>.<field>`
- 类型约定：

  - ID类：string
  - 数值类：int/float（token数、耗时、成本）
  - 布尔类：boolean（success、allowed）
  - 复杂对象：JSON字符串（args、result）

### 3、Span 层级和所需 Attributes

- 1\. session（会话根Span）


| 字段名                           | 类型   | 确定使用 | 示例值 | 说明                             |
| ---------------------------------- | -------- | ---------- | -------- | ---------------------------------- |
| [session\.id](http://session.id) | string | √       |        |                                  |
| vehicle[\.id](http://user.id)    | string | √       |        |                                  |
| user\.id                         | string | √       |        |                                  |
| agent\.version                   | string | √       |        |                                  |
| session\.error                   | string |          |        |                                  |
| session\.output\_text            | string |          |        |                                  |
| session\.duration\_ms            | int    |          |        | OTel自动计算，冗余               |
| session\.total\_tokens           | int    |          |        | 聚合字段，可能需要从子 span 计算 |

- 2、turn


| 字段名             | 类型 | 确定使用 | 示例值 | 说明   |
| -------------------- | ------ | ---------- | -------- | -------- |
| turn\.index        | int  | √       |        | 第几轮 |
| turn\.tool\_calls  | int  |          |        | 多少次 |
| turn\.duration\_ms | int  |          |        |        |
| turn\.tokens       | int  |          |        |        |
|                    |      |          |        |        |
|                    |      |          |        |        |
|                    |      |          |        |        |
|                    |      |          |        |        |

- 3\. model


| 字段名                | 类型   | 确定使用         | 示例值 | 说明                           |
| ----------------------- | -------- | ------------------ | -------- | -------------------------------- |
| model\.provider       | string |                  |        |                                |
| model\.name           | string |                  |        |                                |
| model\.input\_tokens  | int    |                  |        |                                |
| model\.output\_tokens | int    |                  |        |                                |
| model\.latency\_ms    | int    |                  |        |                                |
| model\.input\_text    | string | 需要，但可能分解 |        | 可能需要细分上下文组成         |
| model\.output\_text   | string | 需要，但可能分解 |        | 可能需要区分message/tool\_call |
| model\.error          | string |                  |        |                                |

- 4\. tool


| 字段名             | 类型           | 确定使用       | 示例值 | 说明                       |
| -------------------- | ---------------- | ---------------- | -------- | ---------------------------- |
| tool\.name         | string         | √             |        |                            |
| tool\.args         | string\(json\) | √             |        | schema                     |
| tool\.result       | string         | 需要，但不确定 |        | 也可能作为llm\.input\_text |
| tool\.duration\_ms | int            |                |        |                            |
| tool\.error        | string         |                |        |                            |
|                    |                |                |        |                            |
|                    |                |                |        |                            |
|                    |                |                |        |                            |

- 5\. hook\(可能作为tool的子span\)


| 字段名               | 类型   | 确定使用     | 示例值 | 说明                                 |
| ---------------------- | -------- | -------------- | -------- | -------------------------------------- |
| hook\.name           | string | √           |        |                                      |
| hook\.blocked        | bool   | √           |        | 是否放行如果放行，可以考虑不收集以下 |
| hook\.reason         | string | 当blocked==1 |        |                                      |
| hook\.error          | string |              |        |                                      |
| hook\.data           | string | 当blocked==1 |        |                                      |
| hook\.modified\_data | string | 当blocked==1 |        |                                      |
|                      |        |              |        |                                      |
|                      |        |              |        |                                      |

5、可能需要脱敏的字段
\- model\.input\_text（可能含用户隐私）
\- tool\.args（可能含密码、密钥）
\- [user\.id](http://user.id)/vehicle[\.id](http://user.id) （关联真实身份）
